import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import type { KeywordResult, SessionRecord, SerpItem, StepLog } from "../types";

// ── Styling constants ─────────────────────────────────────────────────────────

const STEP_COLOR: Record<string, string> = {
  running: "text-blue-400",
  success: "text-emerald-400",
  failed:  "text-red-400",
};
const STEP_ICON: Record<string, string> = {
  running: "▶",
  success: "✓",
  failed:  "✗",
};
const ALERT_STEPS = new Set([
  "max_retry_exceeded", "no_device_globally", "no_device_available",
  "device_timeout", "device_timeout_no_replacement",
]);

// ── Log helpers ───────────────────────────────────────────────────────────────

function parseKw(detail?: string): string | null {
  if (!detail) return null;
  const m = detail.match(/\bkw=["']([^"']+)["']/i);
  return m ? m[1] : null;
}
function stripKw(detail: string): string {
  return detail
    .replace(/\bkw=["'][^"']*["'][,;\s]*/gi, "")
    .replace(/\bkw=[^\s,;|"']+[,;\s]*/gi, "")
    .trim();
}

interface LogGroup { kw: string | null; logs: StepLog[] }

function buildLogGroups(logs: StepLog[]): LogGroup[] {
  const groups: LogGroup[] = [];
  for (const log of logs) {
    const kw = parseKw(log.detail);
    const last = groups[groups.length - 1];
    if (kw && kw !== last?.kw) {
      groups.push({ kw, logs: [log] });
    } else if (last) {
      last.logs.push(log);
    } else {
      groups.push({ kw: null, logs: [log] });
    }
  }
  return groups;
}

/**
 * Filter logs that belong to a session.
 * Same dual-discriminator logic as DeviceColumn.sessionLogs:
 *   1. batchId match (primary)
 *   2. dept tag in detail (secondary, for null-batchId logs)
 */
function getSessionLogs(allLogs: StepLog[], sess: SessionRecord): StepLog[] {
  const end = sess.finishedAt ?? Infinity;
  return allLogs.filter((l) => {
    if (l.deviceId !== sess.deviceId) return false;
    if (l.ts < sess.sentAt - 2000 || l.ts > end + 5000) return false;
    if (l.batchId != null) return l.batchId === sess.sessionId;
    const deptTag = l.detail?.match(/dept=([0-9a-f-]+)/i)?.[1];
    if (deptTag && deptTag !== sess.deptId) return false;
    return true;
  });
}

// ── Dialog device group (one column per physical device) ──────────────────────

interface DialogDeviceGroup {
  deviceId: string;
  deviceName: string;
  ownSessions: SessionRecord[];
  /** Sessions from other devices that were taken over by this device */
  borrowedItems: Array<{ takeoverLog: StepLog; sess: SessionRecord }>;
}

/**
 * Build device groups for the history dialog.
 * - Groups own sessions by deviceId.
 * - Detects borrowed (takeover) sessions via takeover_reassigned logs:
 *   the log's deviceId is the replacement device, jobId/batchId identifies the session.
 */
function buildDialogDeviceGroups(
  sessions: SessionRecord[],
  allLogs: StepLog[]
): DialogDeviceGroup[] {
  const map = new Map<string, DialogDeviceGroup>();

  for (const sess of sessions) {
    if (!map.has(sess.deviceId)) {
      map.set(sess.deviceId, {
        deviceId: sess.deviceId,
        deviceName: sess.deviceName || sess.deviceId,
        ownSessions: [],
        borrowedItems: [],
      });
    }
    map.get(sess.deviceId)!.ownSessions.push(sess);
  }

  // Detect takeover: takeover_reassigned log.deviceId = replacement device
  const seen = new Set<string>();
  for (const log of allLogs) {
    if (log.step !== "takeover_reassigned") continue;
    const refId = log.jobId ?? log.batchId;
    if (!refId) continue;

    const sess = sessions.find(
      (s) => s.sessionId === log.jobId || s.sessionId === log.batchId
    );
    if (!sess || log.deviceId === sess.deviceId) continue;

    const dedup = `${log.deviceId}:${sess.sessionId}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    if (!map.has(log.deviceId)) {
      const nameFromSess = sessions.find((s) => s.deviceId === log.deviceId)?.deviceName;
      map.set(log.deviceId, {
        deviceId: log.deviceId,
        deviceName: nameFromSess || log.deviceId,
        ownSessions: [],
        borrowedItems: [],
      });
    }
    map.get(log.deviceId)!.borrowedItems.push({ takeoverLog: log, sess });
  }

  return [...map.values()];
}

// ── Batch group helpers ───────────────────────────────────────────────────────

interface BatchGroup {
  batchSendId: string;
  sessions: SessionRecord[];
  sentAt: number;
  aggStatus: "pending" | "success" | "failed";
}

function buildBatchGroups(sessions: SessionRecord[]): BatchGroup[] {
  const map = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    const key = s.batchSendId ?? s.sessionId;
    const arr = map.get(key) ?? [];
    arr.push(s);
    map.set(key, arr);
  }
  const groups: BatchGroup[] = [];
  for (const [batchSendId, sesses] of map) {
    const aggStatus: BatchGroup["aggStatus"] =
      sesses.some((s) => s.status === "pending")  ? "pending"  :
      sesses.some((s) => s.status === "failed")   ? "failed"   : "success";
    groups.push({
      batchSendId,
      sessions: sesses,
      sentAt: Math.min(...sesses.map((s) => s.sentAt)),
      aggStatus,
    });
  }
  return groups.sort((a, b) => b.sentAt - a.sentAt);
}

// ── Main dialog ───────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
  /** Pre-select a batch group on open */
  initialBatchSendId?: string | null;
}

type TabId = "sent" | "results";

export function ViewAllDialog({ onClose, initialBatchSendId }: Props) {
  const [activeTab,   setActiveTab]   = useState<TabId>("sent");
  const [expandedKw,  setExpandedKw]  = useState<string | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(
    initialBatchSendId ?? null,
  );

  const sessions = useStore((s) => s.sessions);
  const allLogs  = useStore((s) => s.logs);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const batchGroups = buildBatchGroups(sessions);

  // Filter sessions by selected batch group (null = all)
  const visibleSessions = selectedBatch
    ? sessions.filter((s) => (s.batchSendId ?? s.sessionId) === selectedBatch)
    : sessions;

  // Build device groups (one column per physical device, with borrowed session detection)
  const deviceGroups = buildDialogDeviceGroups(visibleSessions, allLogs);

  // KHU summary for visible sessions
  const khuMap = new Map<string, { name: string; color: string; sessions: SessionRecord[] }>();
  for (const sess of visibleSessions) {
    if (!khuMap.has(sess.deptId)) {
      khuMap.set(sess.deptId, { name: sess.deptName, color: sess.deptColor, sessions: [] });
    }
    khuMap.get(sess.deptId)!.sessions.push(sess);
  }

  const pendingCnt = visibleSessions.filter((s) => s.status === "pending").length;
  const successCnt = visibleSessions.filter((s) => s.status === "success").length;
  const failedCnt  = visibleSessions.filter((s) => s.status === "failed").length;

  return (
    <div className="fixed inset-0 flex flex-col bg-gray-950" style={{ zIndex: 60 }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-gray-800/80 bg-gray-950">

        {/* Row 1: title + KHU chips + totals + close */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-800/40">
          {/* Title */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-bold text-gray-200 uppercase tracking-widest">
              Phiên gửi
            </span>
            <span className="text-[10px] font-mono bg-gray-800 text-gray-400 border border-gray-700 px-1.5 py-0.5 rounded">
              {visibleSessions.length}
            </span>
          </div>

          {/* KHU status chips */}
          <div className="flex items-center gap-1.5 flex-1 flex-wrap min-w-0">
            {[...khuMap.entries()].map(([id, khu]) => {
              const hasPending = khu.sessions.some((s) => s.status === "pending");
              const hasFailed  = khu.sessions.some((s) => s.status === "failed");
              const agg        = hasPending ? "pending" : hasFailed ? "failed" : "success";
              const chip =
                agg === "pending"
                  ? "border-amber-700/40 bg-amber-950/40"
                  : agg === "success"
                  ? "border-emerald-700/30 bg-emerald-950/30"
                  : "border-red-700/30 bg-red-950/30";
              const succKw = khu.sessions.reduce((a, s) => a + s.results.filter((r) => r.status === "success").length, 0);
              const failKw = khu.sessions.reduce((a, s) => a + s.results.filter((r) => r.status === "failed").length, 0);
              return (
                <div key={id} className={`flex items-center gap-1 px-2 py-1 rounded-xl border text-[10px] ${chip}`}>
                  <span className={`text-[9px] px-1.5 py-px rounded-full font-bold border ${khu.color}`}>
                    {khu.name}
                  </span>
                  <span className={`font-bold ${agg === "pending" ? "text-amber-300 animate-pulse" : agg === "success" ? "text-emerald-300" : "text-red-300"}`}>
                    {agg === "pending" ? "CHỜ" : agg === "success" ? "OK" : "LỖI"}
                  </span>
                  {succKw > 0 && <span className="text-emerald-400 font-bold">✓{succKw}</span>}
                  {failKw > 0 && <span className="text-red-400 font-bold">✗{failKw}</span>}
                </div>
              );
            })}
          </div>

          {/* Total status */}
          <div className="flex items-center gap-1.5 shrink-0">
            {pendingCnt > 0 && (
              <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-amber-900/50 text-amber-300 border border-amber-700/30 animate-pulse">
                ⏳ {pendingCnt}
              </span>
            )}
            {successCnt > 0 && (
              <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-emerald-900/40 text-emerald-300 border border-emerald-700/30">
                ✓ {successCnt}
              </span>
            )}
            {failedCnt > 0 && (
              <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-red-900/40 text-red-300 border border-red-700/30">
                ✗ {failedCnt}
              </span>
            )}
            <button
              onClick={onClose}
              className="ml-2 w-8 h-8 flex items-center justify-center rounded-xl text-gray-500 hover:text-gray-100 hover:bg-gray-800 transition-colors text-xl leading-none"
              title="Đóng (Esc)"
            >
              ×
            </button>
          </div>
        </div>

        {/* Row 2: Batch group selector */}
        <div className="flex items-center gap-1.5 px-5 py-2 overflow-x-auto scrollbar-none">
          <span className="text-[9px] text-gray-600 uppercase font-bold tracking-wider shrink-0 mr-1">
            Lần gửi:
          </span>
          {/* "Tất cả" chip */}
          <button
            onClick={() => setSelectedBatch(null)}
            className={`flex items-center gap-1.5 shrink-0 px-3 py-1 rounded-full text-[10px] font-bold border transition-colors ${
              selectedBatch === null
                ? "bg-gray-700 text-gray-100 border-gray-500"
                : "bg-gray-900 text-gray-500 border-gray-800 hover:border-gray-700 hover:text-gray-400"
            }`}
          >
            Tất cả
            <span className="text-[9px] opacity-70">{sessions.length}</span>
          </button>
          {batchGroups.map((group) => {
            const isSelected = selectedBatch === group.batchSendId;
            const t = new Date(group.sentAt).toLocaleTimeString("vi-VN", {
              hour12: false, hour: "2-digit", minute: "2-digit",
            });
            const totalKw = group.sessions.reduce((a, s) => a + s.keywords.length, 0);
            const chip =
              isSelected
                ? group.aggStatus === "pending"  ? "bg-amber-800/60 text-amber-100 border-amber-600"
                  : group.aggStatus === "success" ? "bg-emerald-800/60 text-emerald-100 border-emerald-600"
                                                  : "bg-red-800/60 text-red-100 border-red-600"
                : group.aggStatus === "pending"  ? "bg-amber-950/30 text-amber-400 border-amber-800/40 hover:border-amber-700 animate-pulse"
                  : group.aggStatus === "success" ? "bg-emerald-950/20 text-emerald-500 border-emerald-800/30 hover:border-emerald-700"
                                                  : "bg-red-950/20 text-red-500 border-red-800/30 hover:border-red-700";
            return (
              <button
                key={group.batchSendId}
                onClick={() => setSelectedBatch(group.batchSendId)}
                className={`flex items-center gap-1.5 shrink-0 px-3 py-1 rounded-full text-[10px] font-bold border transition-colors ${chip}`}
              >
                <span>{t}</span>
                <span className="opacity-70">·</span>
                <span>{group.sessions.length} khu</span>
                <span className="opacity-70">·</span>
                <span>{totalKw} kw</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* TOP: Device columns grouped by physical device (55%) */}
        <div
          className="border-b border-gray-800/60 overflow-hidden flex flex-col"
          style={{ height: "55%" }}
        >
          <div className="shrink-0 px-5 py-1.5 flex items-center gap-2 border-b border-gray-800/30">
            <span className="text-[9px] font-bold text-gray-600 uppercase tracking-widest">
              Thiết bị &amp; Log
            </span>
            <span className="text-[9px] text-gray-700">
              — {deviceGroups.length} thiết bị · {visibleSessions.length} phiên
            </span>
          </div>
          <div className="flex-1 overflow-x-auto overflow-y-hidden">
            <div className="flex gap-3 px-4 py-3 h-full items-stretch" style={{ minWidth: "max-content" }}>
              {deviceGroups.length === 0 ? (
                <div className="flex items-center justify-center w-full h-full text-gray-600 text-sm italic">
                  Không có phiên nào
                </div>
              ) : (
                deviceGroups.map((group) => (
                  <DialogDeviceColumn
                    key={group.deviceId}
                    group={group}
                    allLogs={allLogs}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {/* BOTTOM: Tabs (45%) */}
        <div className="flex flex-col overflow-hidden" style={{ height: "45%" }}>
          {/* Tab bar */}
          <div className="shrink-0 flex items-end gap-px px-4 pt-2 border-b border-gray-800/60 bg-gray-950">
            {(["sent", "results"] as TabId[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-1.5 text-[11px] font-semibold rounded-t-lg transition-all border border-b-0 ${
                  activeTab === tab
                    ? "bg-gray-900 text-gray-100 border-gray-700/60"
                    : "bg-transparent text-gray-600 border-transparent hover:text-gray-400 hover:bg-gray-900/30"
                }`}
              >
                {tab === "sent" ? "Dữ liệu gửi" : "Kết quả"}
                <span className={`ml-1.5 text-[9px] px-1 py-px rounded font-mono ${
                  activeTab === tab ? "bg-gray-700 text-gray-300" : "text-gray-700"
                }`}>
                  {tab === "sent" ? visibleSessions.length : visibleSessions.reduce((a, s) => a + s.results.length, 0)}
                </span>
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-auto min-h-0 bg-gray-950">
            {activeTab === "sent" ? (
              <SentDataTable sessions={visibleSessions} />
            ) : (
              <AllResultsView
                sessions={visibleSessions}
                expandedKw={expandedKw}
                onToggleKw={(uid) => setExpandedKw(expandedKw === uid ? null : uid)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Dialog device column (one per physical device, mirrors live DeviceColumn) ──

function DialogDeviceColumn({
  group,
  allLogs,
}: {
  group: DialogDeviceGroup;
  allLogs: StepLog[];
}) {
  // Aggregate status across all sessions on this device
  const hasPending =
    group.ownSessions.some((s) => s.status === "pending") ||
    group.borrowedItems.some((b) => b.sess.status === "pending");
  const hasFailed =
    group.ownSessions.some((s) => s.status === "failed") ||
    group.borrowedItems.some((b) => b.sess.status === "failed");
  const aggStatus = hasPending ? "pending" : hasFailed ? "failed" : "success";

  const cardBorder =
    aggStatus === "pending" ? "border-blue-800/50"      :
    aggStatus === "success" ? "border-emerald-800/30"   : "border-red-800/30";

  const dotCls =
    aggStatus === "pending" ? "bg-blue-400 animate-pulse" :
    aggStatus === "success" ? "bg-emerald-400"            : "bg-red-500";

  // Logs scoped to this physical device (for borrowed session filtering)
  const deviceLogs = allLogs.filter((l) => l.deviceId === group.deviceId);

  // Own sessions newest-first, with the newest auto-expanded
  const sortedOwn = [...group.ownSessions].sort((a, b) => b.sentAt - a.sentAt);
  const [expandedId, setExpandedId] = useState<string | null>(sortedOwn[0]?.sessionId ?? null);

  const totalResults = group.ownSessions.reduce((a, s) => a + s.results.length, 0);

  // All KHU chips for this device (own + borrowed) — shown in header
  const khuChips = [
    ...group.ownSessions.map((s) => ({
      key: `own-${s.sessionId}`, color: s.deptColor, name: s.deptName,
    })),
    ...group.borrowedItems.map((b) => ({
      key: `borrow-${b.sess.sessionId}`, color: b.sess.deptColor, name: b.sess.deptName,
    })),
  ];

  return (
    <div
      className={`flex flex-col bg-gray-900 border rounded-2xl min-w-[276px] w-[276px] shrink-0 overflow-hidden ${cardBorder}`}
      style={{ height: "100%" }}
    >
      {/* ── Device header ─────────────────────────────────────────────── */}
      <div className="shrink-0">
        <div className="flex items-start gap-2.5 px-3.5 pt-3 pb-2">
          {/* Status dot */}
          <div className="mt-0.5 shrink-0 relative">
            <span className={`block w-2.5 h-2.5 rounded-full ${dotCls}`} />
            {aggStatus === "pending" && (
              <span className="absolute inset-0 rounded-full opacity-50 animate-ping bg-blue-400" />
            )}
          </div>
          {/* Device name + ID */}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold text-white leading-snug truncate">
              {group.deviceName}
            </p>
            <p className="text-[9px] font-mono text-gray-700 leading-snug mt-0.5 truncate">
              {group.deviceId}
            </p>
          </div>
          {/* KHU chips stacked on right */}
          <div className="flex flex-col items-end gap-1 shrink-0">
            {khuChips.map(({ key, color, name }) => (
              <span key={key} className={`text-[9px] px-1.5 py-px rounded-full font-bold border ${color}`}>
                {name}
              </span>
            ))}
          </div>
        </div>
        <div className="border-t border-gray-800/60" />
      </div>

      {/* ── Sessions body ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0 px-2 py-2 space-y-1.5">
        {/* Borrowed sessions (TH2b takeover) — shown first, like live view */}
        {group.borrowedItems.map(({ takeoverLog, sess }) => (
          <DialogBorrowedCard
            key={`borrowed-${sess.sessionId}`}
            session={sess}
            takeoverLog={takeoverLog}
            deviceLogs={deviceLogs}
          />
        ))}

        {/* Own sessions */}
        {group.ownSessions.length === 0 && group.borrowedItems.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-[11px] text-gray-700 italic">Chưa có phiên</p>
          </div>
        ) : (
          sortedOwn.map((sess) => {
            const logs      = getSessionLogs(allLogs, sess);
            const isExpanded = expandedId === sess.sessionId;
            return (
              <DialogSessionCard
                key={sess.sessionId}
                session={sess}
                logs={logs}
                isExpanded={isExpanded}
                onToggle={() => setExpandedId(isExpanded ? null : sess.sessionId)}
              />
            );
          })
        )}
      </div>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      {totalResults > 0 && (
        <div className="shrink-0 border-t border-gray-800/60 p-2 bg-gray-950/40">
          <span className="w-full flex items-center justify-center gap-2 py-1.5 text-[10px] text-gray-600 font-mono">
            {totalResults} kết quả — xem trong tab bên dưới
          </span>
        </div>
      )}
    </div>
  );
}

// ── Own session card (collapsible, mirrors live SessionCard) ──────────────────

function DialogSessionCard({
  session: sess,
  logs,
  isExpanded,
  onToggle,
}: {
  session: SessionRecord;
  logs: StepLog[];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [showResults, setShowResults] = useState(false);

  const succCnt    = sess.results.filter((r) => r.status === "success").length;
  const failCnt    = sess.results.filter((r) => r.status === "failed").length;
  const pendingCnt = sess.keywords.length - sess.results.length;

  const t = new Date(sess.sentAt).toLocaleTimeString("vi-VN", {
    hour12: false, hour: "2-digit", minute: "2-digit",
  });
  const dur = sess.finishedAt
    ? `${Math.round((sess.finishedAt - sess.sentAt) / 1000)}s`
    : null;

  const statusCls =
    sess.status === "pending"
      ? "bg-amber-900/60 text-amber-200 border-amber-700/40 animate-pulse"
      : sess.status === "success"
      ? "bg-emerald-900/60 text-emerald-200 border-emerald-700/40"
      : "bg-red-900/60 text-red-200 border-red-700/40";

  const cardBorderCls =
    sess.status === "pending"  ? "border-amber-800/30"   :
    sess.status === "success"  ? "border-emerald-800/30" : "border-red-800/30";

  const groups = buildLogGroups(logs);

  return (
    <>
      <div className={`border rounded-xl overflow-hidden ${cardBorderCls} bg-gray-900/60`}>
        {/* Session row — click to toggle logs */}
        <button
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/30 transition-colors"
          onClick={onToggle}
        >
          {/* KHU badge */}
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold border shrink-0 ${sess.deptColor}`}>
            {sess.deptName}
          </span>

          {/* Time + kw count */}
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-gray-400 leading-tight">
              {t}{dur ? ` · ${dur}` : ""} · {sess.keywords.length} kw
            </p>
          </div>

          {/* Result mini-stats */}
          {sess.results.length > 0 && (
            <div className="flex items-center gap-1 shrink-0 text-[9px]">
              {succCnt > 0 && <span className="text-emerald-400 font-bold">✓{succCnt}</span>}
              {failCnt > 0 && <span className="text-red-400 font-bold">✗{failCnt}</span>}
            </div>
          )}

          {/* Status pill */}
          <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase border shrink-0 ${statusCls}`}>
            {sess.status === "pending" ? "chờ" : sess.status === "success" ? "OK" : "lỗi"}
          </span>

          {/* Expand arrow */}
          <span className="text-gray-700 text-[9px] shrink-0">{isExpanded ? "▲" : "▼"}</span>
        </button>

        {/* Expanded step logs */}
        {isExpanded && (
          <div className="border-t border-gray-800/40 px-2 py-1.5 space-y-px max-h-[320px] overflow-y-auto">
            {groups.length === 0 ? (
              <p className="text-[10px] text-gray-700 italic px-1 py-2">
                {sess.status === "pending" ? "Đang chờ logs…" : "Không có log"}
              </p>
            ) : (
              groups.map((group, gi) => (
                <div key={gi}>
                  {group.kw && (
                    <div className="flex items-center gap-1.5 my-1 px-0.5">
                      <div className="flex-1 h-px bg-gray-800" />
                      <span className="text-[9px] font-bold px-1.5 py-px rounded-full border bg-gray-800 text-gray-400 border-gray-700">
                        {group.kw}
                      </span>
                      <div className="flex-1 h-px bg-gray-800" />
                    </div>
                  )}
                  {group.logs.map((log, i) => (
                    <InlineLogRow key={i} log={log} />
                  ))}
                </div>
              ))
            )}
            {sess.status === "pending" && pendingCnt > 0 && (
              <div className="px-1.5 py-1 mt-1 text-[9px] text-amber-500/70 italic border-t border-gray-800/30">
                ⏳ {pendingCnt} keyword đang xử lý…
              </div>
            )}
          </div>
        )}

        {/* Results quick-view button (only when expanded) */}
        {isExpanded && sess.results.length > 0 && (
          <div className="px-2 pb-2 pt-1 border-t border-gray-800/40">
            <button
              onClick={() => setShowResults(true)}
              className="w-full flex items-center justify-center gap-1.5 py-1 text-[10px] font-semibold rounded-lg bg-blue-950/40 hover:bg-blue-900/50 text-blue-300 border border-blue-800/30 transition-colors"
            >
              Xem kết quả
              <span className="text-[9px] font-bold bg-blue-800/60 text-blue-200 px-1 py-px rounded">
                {sess.results.length}
              </span>
            </button>
          </div>
        )}
      </div>

      {showResults && (
        <InlineResultsDialog session={sess} onClose={() => setShowResults(false)} />
      )}
    </>
  );
}

// ── Borrowed session card (TH2b takeover, mirrors live BorrowedSessionCard) ───

function DialogBorrowedCard({
  session: sess,
  takeoverLog,
  deviceLogs,
}: {
  session: SessionRecord;
  takeoverLog: StepLog;
  deviceLogs: StepLog[];
}) {
  const [showResults, setShowResults] = useState(false);
  const [isExpanded, setIsExpanded]   = useState(true);

  const succCnt    = sess.results.filter((r) => r.status === "success").length;
  const failCnt    = sess.results.filter((r) => r.status === "failed").length;
  const pendingCnt = sess.keywords.length - sess.results.length;

  const t = new Date(sess.sentAt).toLocaleTimeString("vi-VN", {
    hour12: false, hour: "2-digit", minute: "2-digit",
  });
  const dur = sess.finishedAt
    ? `${Math.round((sess.finishedAt - sess.sentAt) / 1000)}s`
    : null;

  // Filter borrowed logs using the same dual-discriminator logic as BorrowedSessionCard
  const sessionEnd = sess.finishedAt ?? Infinity;
  const borrowedLogs = deviceLogs.filter((l) => {
    if (l.step === "takeover_reassigned") return false;
    if (takeoverLog.batchId != null && l.batchId === takeoverLog.batchId) return true;
    if (l.batchId == null && l.ts >= takeoverLog.ts && l.ts <= sessionEnd + 5000) {
      const deptTag = l.detail?.match(/dept=([0-9a-f-]+)/i)?.[1];
      if (deptTag && deptTag !== sess.deptId) return false;
      return true;
    }
    return false;
  });
  const groups = buildLogGroups(borrowedLogs);

  const borderCls =
    sess.status === "pending"  ? "border-amber-700/50 bg-amber-950/10"      :
    sess.status === "success"  ? "border-emerald-700/40 bg-emerald-950/10"  :
                                 "border-red-700/40 bg-red-950/10";

  const statusCls =
    sess.status === "pending"
      ? "bg-amber-900/60 text-amber-200 border-amber-700/40 animate-pulse"
      : sess.status === "success"
      ? "bg-emerald-900/60 text-emerald-200 border-emerald-700/40"
      : "bg-red-900/60 text-red-200 border-red-700/40";

  return (
    <>
      <div className={`border rounded-xl overflow-hidden ${borderCls}`}>
        {/* Takeover banner */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-950/40 border-b border-orange-800/30">
          <span className="text-orange-400 text-[10px] font-bold shrink-0">⇄</span>
          <span className="text-[10px] text-orange-300 font-semibold flex-1 min-w-0 truncate">
            {takeoverLog.detail || "Chạy thay thiết bị khác"}
          </span>
        </div>

        {/* Session row — click to toggle */}
        <button
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/20 transition-colors"
          onClick={() => setIsExpanded((v) => !v)}
        >
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold border shrink-0 ${sess.deptColor}`}>
            {sess.deptName}
          </span>

          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-gray-400 leading-tight">
              {t}{dur ? ` · ${dur}` : ""} · {sess.keywords.length} kw
            </p>
          </div>

          {sess.results.length > 0 && (
            <div className="flex items-center gap-1 shrink-0 text-[9px]">
              {succCnt > 0 && <span className="text-emerald-400 font-bold">✓{succCnt}</span>}
              {failCnt > 0 && <span className="text-red-400 font-bold">✗{failCnt}</span>}
              {pendingCnt > 0 && sess.status === "pending" && (
                <span className="text-amber-400/70 animate-pulse">⏳{pendingCnt}</span>
              )}
            </div>
          )}

          <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase border shrink-0 ${statusCls}`}>
            {sess.status === "pending" ? "chờ" : sess.status === "success" ? "OK" : "lỗi"}
          </span>

          <span className="text-gray-700 text-[9px] shrink-0">{isExpanded ? "▲" : "▼"}</span>
        </button>

        {/* Expanded step logs */}
        {isExpanded && (
          <div className="border-t border-orange-800/20 px-2 py-1.5 space-y-px max-h-[280px] overflow-y-auto">
            {groups.length === 0 ? (
              <p className="text-[10px] text-gray-700 italic px-1 py-2">
                {sess.status === "pending" ? "Đang chờ logs…" : "Không có log"}
              </p>
            ) : (
              groups.map((group, gi) => (
                <div key={gi}>
                  {group.kw && (
                    <div className="flex items-center gap-1.5 my-1 px-0.5">
                      <div className="flex-1 h-px bg-orange-900/30" />
                      <span className="text-[9px] font-bold px-1.5 py-px rounded-full border bg-orange-950/40 text-orange-300/70 border-orange-800/30">
                        {group.kw}
                      </span>
                      <div className="flex-1 h-px bg-orange-900/30" />
                    </div>
                  )}
                  {group.logs.map((log, i) => (
                    <InlineLogRow key={i} log={log} />
                  ))}
                </div>
              ))
            )}
            {sess.status === "pending" && pendingCnt > 0 && (
              <div className="px-1.5 py-1 text-[9px] text-amber-500/70 italic border-t border-orange-800/20 mt-1">
                ⏳ {pendingCnt} keyword đang xử lý…
              </div>
            )}
          </div>
        )}

        {/* Results quick-view button */}
        {sess.results.length > 0 && (
          <div className="px-2 pb-2">
            <button
              onClick={() => setShowResults(true)}
              className="w-full flex items-center justify-center gap-1.5 py-1 text-[10px] font-semibold rounded-lg bg-blue-950/40 hover:bg-blue-900/50 text-blue-300 border border-blue-800/30 transition-colors"
            >
              Xem kết quả
              <span className="text-[9px] font-bold bg-blue-800/60 text-blue-200 px-1 py-px rounded">
                {sess.results.length}
              </span>
            </button>
          </div>
        )}
      </div>

      {showResults && (
        <InlineResultsDialog session={sess} onClose={() => setShowResults(false)} />
      )}
    </>
  );
}

// ── Log row ───────────────────────────────────────────────────────────────────

function InlineLogRow({ log }: { log: StepLog }) {
  const icon    = STEP_ICON[log.status]  ?? "·";
  const color   = STEP_COLOR[log.status] ?? "text-gray-600";
  const time    = new Date(log.ts).toLocaleTimeString("en-US", { hour12: false });
  const isAlert = ALERT_STEPS.has(log.step);
  const detail  = log.detail ? stripKw(log.detail) : "";

  if (isAlert) {
    return (
      <div className="flex items-start gap-1.5 text-[11px] leading-5 rounded-lg px-2 py-1 mb-0.5 bg-red-950/40 border border-red-900/30">
        <span className="text-red-400 font-bold w-3 text-center shrink-0">!</span>
        <span className="text-gray-600 shrink-0 font-mono text-[10px] tabular">{time.slice(0, 8)}</span>
        <span className="flex-1 min-w-0 truncate text-red-200 font-bold">{log.step}</span>
        {detail && (
          <span className="text-red-400/70 text-[10px] shrink-0 font-mono truncate max-w-[60px]">{detail}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-[11px] leading-5 rounded-md px-1.5 py-[3px] hover:bg-gray-800/30 group">
      <span className={`font-bold w-3 text-center shrink-0 text-[10px] ${color}`}>{icon}</span>
      <span className="text-gray-700 shrink-0 font-mono text-[10px] tabular">{time.slice(0, 8)}</span>
      <span className="flex-1 min-w-0 truncate text-gray-400 group-hover:text-gray-300 transition-colors">
        {log.step}
      </span>
      {detail && (
        <span className="text-gray-600 text-[10px] shrink-0 font-mono truncate max-w-[68px]">{detail}</span>
      )}
    </div>
  );
}

// ── Sent data table ───────────────────────────────────────────────────────────

function SentDataTable({ sessions }: { sessions: SessionRecord[] }) {
  if (sessions.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-600 text-sm italic py-10">
        Chưa có dữ liệu gửi
      </div>
    );
  }

  return (
    <table className="w-full text-[11px] border-collapse">
      <thead className="sticky top-0 bg-gray-950 z-10">
        <tr className="border-b border-gray-800">
          <th className="text-left px-4 py-2 text-gray-500 font-semibold uppercase tracking-wider text-[9px] whitespace-nowrap">Thời gian</th>
          <th className="text-left px-3 py-2 text-gray-500 font-semibold uppercase tracking-wider text-[9px]">KHU</th>
          <th className="text-left px-3 py-2 text-gray-500 font-semibold uppercase tracking-wider text-[9px]">Thiết bị</th>
          <th className="text-left px-3 py-2 text-gray-500 font-semibold uppercase tracking-wider text-[9px]">Keywords</th>
          <th className="text-left px-3 py-2 text-gray-500 font-semibold uppercase tracking-wider text-[9px] whitespace-nowrap">Trạng thái</th>
          <th className="text-left px-3 py-2 text-gray-500 font-semibold uppercase tracking-wider text-[9px]">Kết quả</th>
          <th className="text-left px-3 py-2 text-gray-500 font-semibold uppercase tracking-wider text-[9px] whitespace-nowrap">Thời lượng</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-800/40">
        {sessions.map((sess) => {
          const t = new Date(sess.sentAt).toLocaleTimeString("vi-VN", {
            hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
          });
          const dur = sess.finishedAt
            ? `${Math.round((sess.finishedAt - sess.sentAt) / 1000)}s`
            : "—";
          const succCnt = sess.results.filter((r) => r.status === "success").length;
          const failCnt = sess.results.filter((r) => r.status === "failed").length;
          const statusCls =
            sess.status === "pending"
              ? "bg-amber-900/50 text-amber-300 border-amber-700/30 animate-pulse"
              : sess.status === "success"
              ? "bg-emerald-900/50 text-emerald-300 border-emerald-700/30"
              : "bg-red-900/50 text-red-300 border-red-700/30";
          const rowBg =
            sess.status === "failed"
              ? "hover:bg-red-950/10"
              : sess.status === "pending"
              ? "hover:bg-amber-950/10"
              : "hover:bg-gray-900/30";

          return (
            <tr key={sess.sessionId} className={`transition-colors ${rowBg}`}>
              <td className="px-4 py-2.5 font-mono text-gray-500 whitespace-nowrap align-middle">{t}</td>
              <td className="px-3 py-2.5 align-middle">
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold border ${sess.deptColor}`}>
                  {sess.deptName}
                </span>
              </td>
              <td className="px-3 py-2.5 align-middle">
                <p className="text-gray-200 font-semibold truncate max-w-[160px]">{sess.deviceName}</p>
                <p className="text-gray-700 font-mono text-[9px] truncate max-w-[160px] mt-0.5">{sess.deviceId}</p>
              </td>
              <td className="px-3 py-2.5 align-middle">
                <p className="text-gray-400 text-[10px] mb-0.5">{sess.keywords.length} từ khóa</p>
                <p className="text-gray-600 text-[9px] font-mono truncate max-w-[220px]">
                  {sess.keywords.join(", ")}
                </p>
              </td>
              <td className="px-3 py-2.5 align-middle">
                <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold whitespace-nowrap ${statusCls}`}>
                  {sess.status === "pending" ? "CHỜ" : sess.status === "success" ? "OK" : "LỖI"}
                </span>
              </td>
              <td className="px-3 py-2.5 align-middle">
                <div className="flex items-center gap-1.5 text-[10px]">
                  {succCnt > 0 && <span className="text-emerald-400 font-bold">✓{succCnt}</span>}
                  {failCnt > 0 && <span className="text-red-400 font-bold">✗{failCnt}</span>}
                  {sess.results.length === 0 && (
                    <span className="text-gray-700">—</span>
                  )}
                  {succCnt > 0 && (
                    <div className="w-12 h-1 bg-gray-800 rounded-full overflow-hidden ml-1">
                      <div
                        className="h-full bg-emerald-500 rounded-full"
                        style={{ width: `${Math.round((succCnt / sess.keywords.length) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              </td>
              <td className="px-3 py-2.5 text-gray-600 font-mono whitespace-nowrap align-middle">{dur}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── All results view ──────────────────────────────────────────────────────────

function AllResultsView({
  sessions,
  expandedKw,
  onToggleKw,
}: {
  sessions: SessionRecord[];
  expandedKw: string | null;
  onToggleKw: (uid: string) => void;
}) {
  const withResults = sessions.filter((s) => s.results.length > 0 || s.keywords.length > 0);

  if (withResults.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-600 text-sm italic py-10">
        Chưa có kết quả
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-800/60">
      {withResults.map((sess) => {
        const succCnt = sess.results.filter((r) => r.status === "success").length;
        const failCnt = sess.results.filter((r) => r.status === "failed").length;
        const top1    = sess.results.filter((r) => (r.topPosition ?? 999) === 1).length;
        const top3    = sess.results.filter((r) => (r.topPosition ?? 999) <= 3).length;
        const top10   = sess.results.filter((r) => (r.topPosition ?? 999) <= 10).length;
        const pending = sess.keywords.length - sess.results.length;
        const t = new Date(sess.sentAt).toLocaleTimeString("vi-VN", {
          hour12: false, hour: "2-digit", minute: "2-digit",
        });
        const dur = sess.finishedAt
          ? `${Math.round((sess.finishedAt - sess.sentAt) / 1000)}s`
          : null;
        const kwRows = sess.keywords.map((kw) => ({
          kw,
          result: sess.results.find((r) => r.keyword === kw) ?? null,
        }));

        return (
          <div key={sess.sessionId}>
            {/* Session header */}
            <div className="flex items-center gap-2.5 px-4 py-2.5 bg-gray-900/60 sticky top-0 z-10 border-b border-gray-800/40">
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold border shrink-0 ${sess.deptColor}`}>
                {sess.deptName}
              </span>
              <span className="text-[11px] font-semibold text-gray-200">{sess.deviceName}</span>
              <span className="text-[10px] text-gray-600 font-mono">{t}{dur ? ` · ${dur}` : ""}</span>
              <div className="flex items-center gap-2 text-[10px] ml-auto">
                {succCnt > 0 && <span className="text-emerald-400 font-bold">✓{succCnt}</span>}
                {failCnt > 0 && <span className="text-red-400 font-bold">✗{failCnt}</span>}
                {pending > 0 && <span className="text-amber-400/70 animate-pulse">⏳{pending}</span>}
                {top1  > 0 && <span className="text-yellow-400 font-bold">#1×{top1}</span>}
                {top3  > top1 && <span className="text-emerald-400">top3×{top3}</span>}
                {top10 > top3 && <span className="text-blue-400">top10×{top10}</span>}
              </div>
            </div>
            {/* Keyword rows */}
            <div className="divide-y divide-gray-800/30">
              {kwRows.map(({ kw, result }) => {
                const uid = `${sess.sessionId}:${kw}`;
                return (
                  <ResultKwRow
                    key={uid}
                    keyword={kw}
                    result={result}
                    expanded={expandedKw === uid}
                    onToggle={() => onToggleKw(uid)}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Keyword result row ────────────────────────────────────────────────────────

function ResultKwRow({
  keyword,
  result,
  expanded,
  onToggle,
}: {
  keyword: string;
  result: KeywordResult | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isPending   = result === null;
  const isOk        = result?.status === "success";
  const rank        = result ? (result.topPosition ?? result.serp?.[0]?.position ?? null) : null;
  const hasSerpData = result && result.serp && result.serp.length > 0;

  const rankCls =
    rank == null ? "text-gray-600"          :
    rank === 1   ? "text-yellow-400 font-bold" :
    rank <= 3    ? "text-emerald-400 font-bold" :
    rank <= 10   ? "text-blue-400 font-semibold" :
                   "text-gray-500";

  return (
    <div>
      <div
        className={`flex items-center gap-3 px-4 py-2 text-[11px] transition-colors ${
          hasSerpData ? "hover:bg-gray-900/40 cursor-pointer" : ""
        } ${expanded ? "bg-gray-900/30" : ""}`}
        onClick={hasSerpData ? onToggle : undefined}
      >
        <span className={`font-bold w-4 text-center shrink-0 ${
          isPending ? "text-amber-500 animate-pulse" :
          isOk      ? "text-emerald-400"             : "text-red-400"
        }`}>
          {isPending ? "⏳" : isOk ? "✓" : "✗"}
        </span>
        <span className="flex-1 font-semibold text-gray-100 truncate">{keyword}</span>
        {rank != null && (
          <span className={`font-mono tabular shrink-0 ${rankCls}`}>#{rank}</span>
        )}
        {isOk && result?.topDomain && (
          <span className="text-[10px] text-blue-400 font-mono shrink-0 max-w-[180px] truncate">
            {result.topDomain}
          </span>
        )}
        {!isPending && !isOk && result?.failReason && (
          <span className="text-[10px] text-red-400/80 shrink-0 max-w-[180px] truncate">
            {result.failReason}
          </span>
        )}
        {hasSerpData && (
          <span className="text-[9px] text-gray-600 shrink-0 flex items-center gap-0.5">
            {result!.serp.length}kq {expanded ? "▲" : "▼"}
          </span>
        )}
      </div>
      {expanded && hasSerpData && (
        <div className="bg-gray-900/70 border-t border-gray-800/30 px-6 py-3 space-y-2">
          <p className="text-[9px] text-gray-600 uppercase font-bold tracking-wider mb-2">
            Kết quả tìm kiếm ({result!.serp.length})
          </p>
          {result!.serp.map((item) => (
            <SerpRow key={item.position} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── SERP row ──────────────────────────────────────────────────────────────────

function SerpRow({ item }: { item: SerpItem }) {
  const posCls =
    item.position === 1  ? "bg-yellow-500/20 text-yellow-300 border-yellow-600/30" :
    item.position <= 3   ? "bg-emerald-500/20 text-emerald-300 border-emerald-600/30" :
    item.position <= 10  ? "bg-blue-500/20 text-blue-300 border-blue-600/30" :
                           "bg-gray-800/60 text-gray-500 border-gray-700/30";

  return (
    <div className="flex items-start gap-3 text-[10px]">
      <span className={`shrink-0 w-7 h-5 flex items-center justify-center rounded font-bold border tabular-nums ${posCls}`}>
        {item.position}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-gray-300 font-medium truncate leading-tight">{item.title || "—"}</p>
        <p className="text-blue-500 font-mono truncate leading-tight mt-0.5">
          {item.domain || item.link || "—"}
        </p>
      </div>
    </div>
  );
}

// ── Inline results dialog (above ViewAllDialog, z-70) ─────────────────────────

function InlineResultsDialog({
  session: sess,
  onClose,
}: {
  session: SessionRecord;
  onClose: () => void;
}) {
  const [expandedKw, setExpandedKw] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const succCnt = sess.results.filter((r) => r.status === "success").length;
  const failCnt = sess.results.filter((r) => r.status === "failed").length;
  const top1    = sess.results.filter((r) => (r.topPosition ?? 999) === 1).length;
  const top3    = sess.results.filter((r) => (r.topPosition ?? 999) <= 3).length;
  const top10   = sess.results.filter((r) => (r.topPosition ?? 999) <= 10).length;
  const kwRows  = sess.keywords.map((kw) => ({
    kw,
    result: sess.results.find((r) => r.keyword === kw) ?? null,
  }));
  const dur = sess.finishedAt
    ? `${Math.round((sess.finishedAt - sess.sentAt) / 1000)}s`
    : "đang chạy…";

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      style={{ zIndex: 70 }}
      onClick={onClose}
    >
      <div
        className="bg-gray-950 border border-gray-800 rounded-2xl w-full max-w-2xl flex flex-col shadow-2xl"
        style={{ maxHeight: "min(90vh, 700px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-gray-800 shrink-0">
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border shrink-0 ${sess.deptColor}`}>
            {sess.deptName}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-white truncate">{sess.deviceName}</p>
            <p className="text-[9px] font-mono text-gray-600 mt-0.5 truncate">
              {sess.sessionId} · {dur}
            </p>
          </div>
          {/* Rank summary */}
          <div className="flex items-center gap-1.5 text-[10px] shrink-0">
            {top1  > 0 && <span className="text-yellow-400 font-bold">#1×{top1}</span>}
            {top3  > top1 && <span className="text-emerald-400">top3×{top3}</span>}
            {top10 > top3 && <span className="text-blue-400">top10×{top10}</span>}
          </div>
          <span className="text-[11px] text-emerald-400 font-bold">✓{succCnt}</span>
          <span className="text-[11px] text-red-400 font-bold">✗{failCnt}</span>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition-colors text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Keywords */}
        <div className="flex-1 overflow-y-auto min-h-0 divide-y divide-gray-800/30">
          {kwRows.map(({ kw, result }) => {
            const uid = `${sess.sessionId}:${kw}`;
            return (
              <ResultKwRow
                key={uid}
                keyword={kw}
                result={result}
                expanded={expandedKw === uid}
                onToggle={() => setExpandedKw(expandedKw === uid ? null : uid)}
              />
            );
          })}
        </div>

        <div className="shrink-0 border-t border-gray-800 px-5 py-2.5 flex items-center justify-between">
          <span className="text-[10px] text-gray-700">
            {sess.results.length}/{sess.keywords.length} keywords
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-xl transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
