import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import type { DeviceSerialized, SessionRecord, StepLog } from "../types";
import { ResultsDialog } from "./ResultsDialog";

// ── Status styling ────────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  idle:       "bg-gray-500",
  processing: "bg-blue-400 animate-pulse",
  failed:     "bg-red-500",
  recovering: "bg-amber-400 animate-pulse",
  done:       "bg-emerald-400",
  offline:    "bg-gray-700",
};
const STATUS_BADGE: Record<string, string> = {
  idle:       "bg-gray-800/80 text-gray-400 border-gray-700/50",
  processing: "bg-blue-900/60 text-blue-200 border-blue-700/40",
  failed:     "bg-red-900/60 text-red-200 border-red-700/40",
  recovering: "bg-amber-900/60 text-amber-200 border-amber-700/40",
  done:       "bg-emerald-900/60 text-emerald-200 border-emerald-700/40",
  offline:    "bg-gray-900/80 text-gray-600 border-gray-800/60",
};
const STATUS_CARD_BORDER: Record<string, string> = {
  idle:       "border-gray-800",
  processing: "border-blue-800/50 card-processing",
  failed:     "border-red-800/40",
  recovering: "border-amber-800/40",
  done:       "border-emerald-800/40",
  offline:    "border-gray-800/40 opacity-60",
};

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

function buildGroups(logs: StepLog[]): LogGroup[] {
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
 * Filter logs that belong to a session (dual-discriminator: batchId + dept tag).
 *
 * Match order:
 *  1. batchId exact match → include immediately (most precise)
 *  2. batchId set but mismatches → fall through to dept-tag (handles SESS-LAB-* from Python)
 *  3. batchId null/"" → dept-tag fallback
 */
function sessionLogs(allLogs: StepLog[], sess: SessionRecord): StepLog[] {
  const end = sess.finishedAt ?? Infinity;
  return allLogs.filter((l) => {
    if (l.deviceId !== sess.deviceId) return false;
    if (l.ts < sess.sentAt - 2000 || l.ts > end + 5000) return false;
    // Primary discriminator: batchId exact match
    if (l.batchId && l.batchId === sess.sessionId) return true;
    // Secondary discriminator: dept-tag (handles missing/mismatched batchId)
    const deptTag = l.detail?.match(/dept=([0-9a-f-]+)/i)?.[1];
    if (deptTag && deptTag !== sess.deptId) return false;
    return true;
  });
}

// ── Phiên (batch) grouping ─────────────────────────────────────────────────────

interface BatchGroup {
  batchSendId: string;
  sessions: SessionRecord[];   // newest-first (same order as store)
  sentAt: number;              // earliest sentAt in this batch
}

/**
 * Group sessions by batchSendId, preserving newest-first order.
 * The first group = the newest "phiên" (most recently sent batch).
 */
function groupByBatch(sessions: SessionRecord[]): BatchGroup[] {
  const seen  = new Set<string>();
  const order: string[] = [];
  const map   = new Map<string, SessionRecord[]>();

  for (const sess of sessions) {
    const key = sess.batchSendId;
    if (!seen.has(key)) {
      seen.add(key);
      order.push(key);
      map.set(key, []);
    }
    map.get(key)!.push(sess);
  }

  return order.map((batchSendId) => {
    const sesses = map.get(batchSendId)!;
    return {
      batchSendId,
      sessions: sesses,
      sentAt: Math.min(...sesses.map((s) => s.sentAt)),
    };
  });
}

/** Short human-readable label for a batchSendId */
function batchLabel(batchSendId: string): { type: "PROD" | "BATCH"; short: string } {
  if (batchSendId.startsWith("prod-")) {
    return { type: "PROD",  short: batchSendId.slice(-7) };
  }
  return   { type: "BATCH", short: batchSendId.slice(-7) };
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  connectionId: string;
  device: DeviceSerialized;
}

export function DeviceColumn({ connectionId, device }: Props) {
  const [showResults, setShowResults] = useState(false);

  const allLogs = useStore((s) =>
    s.logs.filter((l) => l.connectionId === connectionId && l.deviceId === device.deviceId)
  );
  const deviceSessions = useStore((s) =>
    s.sessions.filter((sess) => sess.deviceId === device.deviceId && sess.connectionId === connectionId)
  );
  const allSessions = useStore((s) => s.sessions);

  // TH2b borrowed sessions
  const borrowedSessions = (() => {
    const seen = new Set<string>();
    const out: { log: StepLog; sess: SessionRecord }[] = [];
    for (const log of allLogs) {
      if (log.step !== "takeover_reassigned") continue;
      const refId = log.jobId ?? log.batchId;
      if (!refId || seen.has(refId)) continue;
      seen.add(refId);
      const sess = allSessions.find(
        (s) => s.sessionId === log.jobId || s.sessionId === log.batchId
      );
      if (sess) out.push({ log, sess });
    }
    return out;
  })();

  // ── Phiên (batch) grouping ──────────────────────────────────────────────────
  const sessionGroups = useMemo(() => groupByBatch(deviceSessions), [deviceSessions]);

  // Track which phiên container is expanded (newest auto-expands)
  const newestBatchId = sessionGroups[0]?.batchSendId ?? null;
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(newestBatchId);

  // When a new phiên arrives → auto-expand it, collapse old
  useEffect(() => {
    if (newestBatchId) setExpandedBatchId(newestBatchId);
  }, [newestBatchId]);

  // Track which individual session's logs are expanded (within current phiên)
  // Auto-expand the newest pending session in the expanded phiên
  const newestPendingId = useMemo(() => {
    const batch = sessionGroups.find((g) => g.batchSendId === expandedBatchId);
    if (!batch) return null;
    return (
      batch.sessions.find((s) => s.status === "pending")?.sessionId ??
      batch.sessions[0]?.sessionId ??
      null
    );
  }, [expandedBatchId, sessionGroups]);

  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(newestPendingId);

  useEffect(() => {
    setExpandedSessionId(newestPendingId);
  }, [newestPendingId]);

  const totalResults = deviceSessions.reduce((a, s) => a + s.results.length, 0);
  const cardBorder   = STATUS_CARD_BORDER[device.status] ?? STATUS_CARD_BORDER.idle;

  return (
    <>
      <div
        className={`flex flex-col bg-gray-900 border rounded-2xl min-w-[276px] w-[276px] shrink-0 overflow-hidden transition-all duration-300 ${cardBorder}`}
        style={{ height: "calc(100vh - 158px)", minHeight: "400px", maxHeight: "700px" }}
      >
        {/* ── Device header ─────────────────────────────────────────────── */}
        <div className="shrink-0">
          <div className="flex items-start gap-2.5 px-3.5 pt-3.5 pb-2">
            {/* Status dot */}
            <div className="mt-0.5 shrink-0 relative">
              <span className={`block w-2.5 h-2.5 rounded-full ${STATUS_DOT[device.status] ?? STATUS_DOT.idle}`} />
              {(device.status === "processing" || device.status === "recovering") && (
                <span className={`absolute inset-0 rounded-full opacity-50 animate-ping ${
                  device.status === "processing" ? "bg-blue-400" : "bg-amber-400"
                }`} />
              )}
            </div>
            {/* Name + model */}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-white leading-snug truncate">
                {device.name || device.deviceId}
              </p>
              <p className="text-[10px] text-gray-500 leading-snug mt-0.5 truncate">
                {device.model || "Unknown"}
              </p>
            </div>
            {/* Status badge */}
            <span className={`text-[10px] px-2 py-0.5 rounded-md font-bold uppercase border shrink-0 mt-0.5 ${STATUS_BADGE[device.status] ?? STATUS_BADGE.idle}`}>
              {device.status}
            </span>
          </div>

          {/* Device ID + retry */}
          <div className="flex items-center gap-2 px-3.5 pb-2.5">
            <span className="text-[9px] font-mono text-gray-700 truncate flex-1 leading-none">
              {device.deviceId}
            </span>
            {device.retryCount > 0 && (
              <span className="text-[10px] text-amber-400 font-bold shrink-0 tabular">
                ↺{device.retryCount}
              </span>
            )}
          </div>

          <div className="border-t border-gray-800/60" />
        </div>

        {/* ── Sessions body ─────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto min-h-0 px-2 py-2 space-y-1.5">

          {/* Borrowed sessions (TH2b takeover) — always on top */}
          {borrowedSessions.map(({ log, sess }) => (
            <BorrowedSessionCard
              key={`borrowed-${sess.sessionId}`}
              session={sess}
              takeoverDetail={log.detail ?? ""}
              takeoverLog={log}
              allLogs={allLogs}
            />
          ))}

          {/* Own sessions grouped by phiên */}
          {sessionGroups.length === 0 && borrowedSessions.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-[11px] text-gray-700 italic">Chưa có phiên nào</p>
            </div>
          ) : (
            sessionGroups.map((group) => (
              <PhienCard
                key={group.batchSendId}
                group={group}
                isExpanded={expandedBatchId === group.batchSendId}
                expandedSessionId={expandedSessionId}
                onToggle={() =>
                  setExpandedBatchId((cur) =>
                    cur === group.batchSendId ? null : group.batchSendId
                  )
                }
                onSessionToggle={(id) => setExpandedSessionId(id)}
                allLogs={allLogs}
              />
            ))
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────────────── */}
        {totalResults > 0 && (
          <div className="shrink-0 border-t border-gray-800/60 p-2.5 bg-gray-950/40">
            <button
              onClick={() => setShowResults(true)}
              className="w-full flex items-center justify-center gap-2 py-2 text-[11px] font-semibold rounded-xl bg-blue-950/40 hover:bg-blue-900/60 active:bg-blue-800/60 text-blue-300 border border-blue-800/30 transition-colors"
            >
              Xem kết quả
              <span className="text-[10px] font-bold bg-blue-800/60 text-blue-200 px-1.5 py-0.5 rounded-md">
                {totalResults}
              </span>
            </button>
          </div>
        )}
      </div>

      {showResults && (
        <ResultsDialog
          deviceName={device.name}
          deviceId={device.deviceId}
          sessions={deviceSessions}
          onClose={() => setShowResults(false)}
        />
      )}
    </>
  );
}

// ── Phiên (batch) container ────────────────────────────────────────────────────

function PhienCard({
  group,
  isExpanded,
  expandedSessionId,
  onToggle,
  onSessionToggle,
  allLogs,
}: {
  group: BatchGroup;
  isExpanded: boolean;
  expandedSessionId: string | null;
  onToggle: () => void;
  onSessionToggle: (id: string | null) => void;
  allLogs: StepLog[];
}) {
  const { batchSendId, sessions, sentAt } = group;
  const { type: batchType, short: shortId } = batchLabel(batchSendId);

  const time = new Date(sentAt).toLocaleTimeString("vi-VN", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  // Aggregate stats
  const totalKw    = sessions.reduce((s, sess) => s + sess.keywords.length, 0);
  const succCnt    = sessions.reduce((s, sess) => s + sess.results.filter((r) => r.status === "success").length, 0);
  const failCnt    = sessions.reduce((s, sess) => s + sess.results.filter((r) => r.status === "failed").length, 0);
  const pendingCnt = sessions.reduce((s, sess) => s + (sess.keywords.length - sess.results.length), 0);
  const hasPending = sessions.some((s) => s.status === "pending");
  const allSuccess = !hasPending && sessions.every((s) => s.status === "success");

  const containerBorder =
    hasPending ? "border-blue-800/40"    :
    allSuccess  ? "border-emerald-800/30" :
                  "border-red-800/30";

  const headerBg = hasPending ? "hover:bg-blue-950/20" : "hover:bg-gray-800/30";

  return (
    <div className={`border rounded-xl overflow-hidden ${containerBorder} bg-gray-900/40`}>
      {/* ── Phiên header (click to expand / collapse) ── */}
      <button
        className={`w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors ${headerBg}`}
        onClick={onToggle}
      >
        {/* Batch type badge */}
        <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold uppercase border shrink-0 ${
          batchType === "PROD"
            ? "bg-emerald-900/60 text-emerald-300 border-emerald-700/40"
            : "bg-blue-900/60 text-blue-300 border-blue-700/40"
        }`}>
          {batchType}
        </span>

        {/* sessionId short + time */}
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-mono text-gray-300 leading-tight truncate">
            #{shortId}
          </p>
          <p className="text-[9px] text-gray-600 leading-tight mt-px">
            {time} · {sessions.length} KHU · {totalKw} kw
          </p>
        </div>

        {/* KHU chips (compact) */}
        <div className="flex items-center gap-0.5 shrink-0 max-w-[72px] flex-wrap justify-end">
          {sessions.map((sess) => (
            <span
              key={sess.sessionId}
              className={`text-[8px] px-1 py-0 rounded-sm font-bold border ${sess.deptColor}`}
            >
              {sess.deptName.replace("KHU ", "")}
            </span>
          ))}
        </div>

        {/* Aggregate stats */}
        <div className="flex items-center gap-1 shrink-0 text-[9px] ml-1">
          {succCnt > 0 && <span className="text-emerald-400 font-bold">✓{succCnt}</span>}
          {failCnt > 0 && <span className="text-red-400 font-bold">✗{failCnt}</span>}
          {hasPending && pendingCnt > 0 && (
            <span className="text-amber-400 animate-pulse font-bold">⏳{pendingCnt}</span>
          )}
        </div>

        {/* Expand arrow */}
        <span className="text-gray-600 text-[10px] shrink-0 ml-0.5">
          {isExpanded ? "▲" : "▼"}
        </span>
      </button>

      {/* ── Session cards inside phiên ── */}
      {isExpanded && (
        <div className="border-t border-gray-800/40 px-2 py-2 space-y-1.5">
          {sessions.map((sess) => {
            const logs = sessionLogs(allLogs, sess);
            const isSessionExpanded = expandedSessionId === sess.sessionId;
            return (
              <SessionCard
                key={sess.sessionId}
                session={sess}
                logs={logs}
                isExpanded={isSessionExpanded}
                onToggle={() =>
                  onSessionToggle(isSessionExpanded ? null : sess.sessionId)
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Session card (collapsible) ─────────────────────────────────────────────────

function SessionCard({
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
    sess.status === "pending"  ? "border-amber-800/30" :
    sess.status === "success"  ? "border-emerald-800/30" : "border-red-800/30";

  const groups = buildGroups(logs);

  return (
    <div className={`border rounded-xl overflow-hidden ${cardBorderCls} bg-gray-900/60`}>
      {/* ── Session row (click to toggle logs) ── */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/30 transition-colors"
        onClick={onToggle}
      >
        {/* KHU badge */}
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold border shrink-0 ${sess.deptColor}`}>
          {sess.deptName}
        </span>

        {/* sessionId (short) + time */}
        <div className="flex-1 min-w-0">
          <p className="text-[9px] font-mono text-gray-500 leading-none truncate">
            {sess.sessionId.slice(0, 20)}
          </p>
          <p className="text-[9px] text-gray-600 leading-tight mt-px">
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

      {/* ── Expanded: step logs ── */}
      {isExpanded && (
        <div className="border-t border-gray-800/40 px-2 py-1.5 space-y-px max-h-[280px] overflow-y-auto">
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
                  <LogRow key={i} log={log} />
                ))}
              </div>
            ))
          )}

          {/* Pending indicator */}
          {sess.status === "pending" && pendingCnt > 0 && (
            <div className="px-1.5 py-1 text-[9px] text-amber-500/70 italic border-t border-gray-800/30 mt-1">
              ⏳ {pendingCnt} keyword đang xử lý…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Borrowed session card (TH2b takeover) ─────────────────────────────────────

function BorrowedSessionCard({
  session: sess,
  takeoverDetail,
  takeoverLog,
  allLogs,
}: {
  session: SessionRecord;
  takeoverDetail: string;
  takeoverLog: StepLog;
  allLogs: StepLog[];
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

  const sessionEnd = sess.finishedAt ?? Infinity;
  const borrowedLogs = allLogs.filter((l) => {
    if (l.step === "takeover_reassigned") return false;
    if (takeoverLog.batchId != null && l.batchId === takeoverLog.batchId) return true;
    if (l.batchId == null && l.ts >= takeoverLog.ts && l.ts <= sessionEnd + 5000) {
      const deptTag = l.detail?.match(/dept=([0-9a-f-]+)/i)?.[1];
      if (deptTag && deptTag !== sess.deptId) return false;
      return true;
    }
    return false;
  });
  const groups = buildGroups(borrowedLogs);

  const borderCls =
    sess.status === "pending"  ? "border-amber-700/50 bg-amber-950/10"     :
    sess.status === "success"  ? "border-emerald-700/40 bg-emerald-950/10" :
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
            {takeoverDetail || "Chạy thay thiết bị khác"}
          </span>
        </div>

        {/* Session row */}
        <button
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/20 transition-colors"
          onClick={() => setIsExpanded((v) => !v)}
        >
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold border shrink-0 ${sess.deptColor}`}>
            {sess.deptName}
          </span>

          <div className="flex-1 min-w-0">
            <p className="text-[9px] font-mono text-gray-500 leading-none truncate">
              {sess.sessionId.slice(0, 20)}
            </p>
            <p className="text-[9px] text-gray-600 leading-tight mt-px">
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

        {/* Expanded logs */}
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
                    <LogRow key={i} log={log} />
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

        {/* Results button */}
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
        <ResultsDialog
          deviceName={sess.deviceName}
          deviceId={sess.deviceId}
          sessions={[sess]}
          onClose={() => setShowResults(false)}
        />
      )}
    </>
  );
}

// ── Log row ───────────────────────────────────────────────────────────────────

function LogRow({ log }: { log: StepLog }) {
  const icon    = STEP_ICON[log.status]  ?? "·";
  const color   = STEP_COLOR[log.status] ?? "text-gray-600";
  const time    = new Date(log.ts).toLocaleTimeString("en-US", { hour12: false });
  const isAlert = ALERT_STEPS.has(log.step);
  const detail  = log.detail ? stripKw(log.detail) : "";

  if (isAlert) {
    return (
      <div className="flex items-start gap-1.5 text-[11px] leading-5 rounded-lg px-2 py-1 mb-0.5 bg-red-950/40 border border-red-900/30">
        <span className="text-red-400 font-bold w-3 text-center shrink-0 mt-px">!</span>
        <span className="text-gray-600 shrink-0 font-mono text-[10px] mt-px tabular">{time.slice(0, 8)}</span>
        <span className="flex-1 min-w-0 truncate text-red-200 font-bold">{log.step}</span>
        {detail && <span className="text-red-400/70 text-[10px] shrink-0 font-mono truncate max-w-[60px]">{detail}</span>}
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
