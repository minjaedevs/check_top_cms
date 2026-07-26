import { useState } from "react";
import { useStore } from "../store/useStore";
import type { KeywordResult, SessionRecord, SerpItem } from "../types";
import { ViewAllDialog } from "./ViewAllDialog";

const ALERT_STEPS = new Set([
  "max_retry_exceeded", "no_device_globally", "no_device_available",
  "device_timeout", "device_timeout_no_replacement",
]);

// ── Main panel ───────────────────────────────────────────────────────────────

export function LogPanel() {
  const [filter, setFilter]         = useState("");
  const [selected, setSelected]     = useState<SessionRecord | null>(null);
  const [showViewAll, setShowViewAll] = useState(false);
  const [viewAllBatch, setViewAllBatch] = useState<string | null>(null);

  const logs     = useStore((s) => s.logs);
  const sessions = useStore((s) => s.sessions);

  // Keep modal in sync when session updates (results stream in)
  const liveSelected = selected
    ? sessions.find((s) => s.sessionId === selected.sessionId) ?? selected
    : null;

  const latestAlerts = [...logs].reverse().filter((l) => ALERT_STEPS.has(l.step)).slice(0, 3);

  const filteredSessions = filter
    ? sessions.filter((s) =>
        s.deptName.toLowerCase().includes(filter.toLowerCase()) ||
        s.deviceName.toLowerCase().includes(filter.toLowerCase()) ||
        s.sessionId.includes(filter) ||
        s.keywords.some((k) => k.toLowerCase().includes(filter.toLowerCase())))
    : sessions;

  const pendingCount = sessions.filter((s) => s.status === "pending").length;
  const successCount = sessions.filter((s) => s.status === "success").length;
  const failedCount  = sessions.filter((s) => s.status === "failed").length;

  return (
    <>
      <aside className="w-[300px] border-l border-gray-800/80 flex flex-col shrink-0 bg-gray-950">

        {/* ── Panel header ── */}
        <div className="shrink-0 px-4 pt-3.5 pb-3 border-b border-gray-800/80">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] font-bold text-gray-300 uppercase tracking-widest">Phiên gửi</p>
            <div className="flex items-center gap-1.5">
              {sessions.length > 0 && (
                <>
                  {pendingCount > 0 && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-900/60 text-amber-300 border border-amber-700/40 animate-pulse">
                      {pendingCount} chờ
                    </span>
                  )}
                  {successCount > 0 && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-900/50 text-emerald-300 border border-emerald-700/30">
                      {successCount} OK
                    </span>
                  )}
                  {failedCount > 0 && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-900/50 text-red-300 border border-red-700/30">
                      {failedCount} lỗi
                    </span>
                  )}
                </>
              )}
              <button
                onClick={() => { setViewAllBatch(null); setShowViewAll(true); }}
                className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 border border-gray-700/60 transition-colors"
                title="Xem toàn bộ phiên gửi"
              >
                Xem tất cả
              </button>
            </div>
          </div>

          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600 text-xs select-none">⌕</span>
            <input
              className="w-full bg-gray-900 border border-gray-800 hover:border-gray-700 focus:border-gray-600 rounded-lg pl-7 pr-3 py-1.5 text-[11px] text-gray-200 placeholder-gray-700 focus:outline-none transition-colors"
              placeholder="KHU / device / keyword…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </div>

        {/* ── Alert banner ── */}
        {latestAlerts.length > 0 && (
          <div className="shrink-0 border-b border-red-900/40 bg-red-950/25 px-4 py-2 space-y-1">
            <p className="text-[9px] text-red-500 uppercase font-bold tracking-widest">⚠ Cảnh báo</p>
            {latestAlerts.map((log, i) => (
              <div key={i} className="text-[11px] text-red-300 font-mono leading-snug truncate">
                <span className="font-bold">{log.step}</span>
                {log.detail && <span className="text-red-400/70 ml-1">{log.detail}</span>}
              </div>
            ))}
          </div>
        )}

        {/* ── Session list ── */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <SessionList
            sessions={filteredSessions}
            onSelect={setSelected}
            onOpenBatch={(batchSendId) => { setViewAllBatch(batchSendId); setShowViewAll(true); }}
          />
        </div>
      </aside>

      {/* ── Detail modal ── */}
      {liveSelected && (
        <SessionDetailModal session={liveSelected} onClose={() => setSelected(null)} />
      )}

      {/* ── View All dialog ── */}
      {showViewAll && (
        <ViewAllDialog
          initialBatchSendId={viewAllBatch}
          onClose={() => setShowViewAll(false)}
        />
      )}
    </>
  );
}

// ── Session list — grouped by batchSendId, collapsible ───────────────────────

interface BatchGroup {
  batchSendId: string;
  sessions: SessionRecord[];
  sentAt: number;       // earliest sentAt in group
  aggStatus: "pending" | "success" | "failed";
}

function buildGroups(sessions: SessionRecord[]): BatchGroup[] {
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
      sesses.some((s) => s.status === "pending")  ? "pending" :
      sesses.some((s) => s.status === "failed")   ? "failed"  : "success";
    groups.push({
      batchSendId,
      sessions: sesses,
      sentAt: Math.min(...sesses.map((s) => s.sentAt)),
      aggStatus,
    });
  }
  // Newest first
  return groups.sort((a, b) => b.sentAt - a.sentAt);
}

function SessionList({
  sessions,
  onSelect,
  onOpenBatch,
}: {
  sessions: SessionRecord[];
  onSelect: (s: SessionRecord) => void;
  onOpenBatch: (batchSendId: string) => void;
}) {
  // Track collapsed groups; default = all expanded (empty set = all open)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (!sessions.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-3">
        <div className="w-12 h-12 rounded-xl bg-gray-900 border border-gray-800 flex items-center justify-center">
          <span className="text-xl">📋</span>
        </div>
        <div>
          <p className="text-[12px] font-semibold text-gray-500">Chưa có phiên nào</p>
          <p className="text-[11px] text-gray-700 mt-1">Nhấn "Gửi Keywords" để bắt đầu</p>
        </div>
      </div>
    );
  }

  const groups = buildGroups(sessions);

  function toggleGroup(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="p-2 space-y-2">
      {groups.map((group) => {
        const isOpen = !collapsed.has(group.batchSendId);
        const totalSucc = group.sessions.reduce(
          (acc, s) => acc + s.results.filter((r) => r.status === "success").length, 0
        );
        const totalFail = group.sessions.reduce(
          (acc, s) => acc + s.results.filter((r) => r.status === "failed").length, 0
        );
        const totalKw = group.sessions.reduce((acc, s) => acc + s.keywords.length, 0);
        const t = new Date(group.sentAt).toLocaleTimeString("vi-VN", {
          hour12: false, hour: "2-digit", minute: "2-digit",
        });
        const firstSessionId = group.sessions[0]?.sessionId ?? group.batchSendId;

        const headerBorder =
          group.aggStatus === "pending"  ? "border-amber-800/40" :
          group.aggStatus === "success"  ? "border-emerald-800/40" :
                                           "border-red-800/40";
        const headerBg =
          group.aggStatus === "pending"  ? "bg-amber-950/20" :
          group.aggStatus === "success"  ? "bg-emerald-950/15" :
                                           "bg-red-950/15";
        const aggPill =
          group.aggStatus === "pending"
            ? "bg-amber-900/60 text-amber-200 border-amber-700/40 animate-pulse"
            : group.aggStatus === "success"
            ? "bg-emerald-900/60 text-emerald-200 border-emerald-700/40"
            : "bg-red-900/60 text-red-200 border-red-700/40";

        return (
          <div key={group.batchSendId} className={`rounded-xl border ${headerBorder} overflow-hidden`}>

            {/* ── Batch header row ── */}
            <div className={`flex items-center gap-1 px-3 py-2 ${headerBg}`}>
              {/* Chevron (collapse/expand) */}
              <button
                className="shrink-0 w-5 text-gray-500 text-[10px] hover:text-gray-300 transition-colors"
                onClick={() => toggleGroup(group.batchSendId)}
              >
                {isOpen ? "▼" : "▶"}
              </button>

              {/* Session info (click → ViewAll for this batch) */}
              <button
                className="flex-1 min-w-0 text-left hover:brightness-110 transition-all"
                onClick={() => onOpenBatch(group.batchSendId)}
              >
                <p className="text-[11px] font-mono font-semibold text-gray-300 leading-tight truncate">
                  {firstSessionId.length > 22 ? firstSessionId.slice(0, 22) + "…" : firstSessionId}
                </p>
                <p className="text-[9px] text-gray-600 leading-tight mt-0.5">
                  {t} · {group.sessions.length} khu · {totalKw} kw
                </p>
              </button>

              {/* Aggregate results */}
              {(totalSucc > 0 || totalFail > 0) && (
                <div className="flex gap-1 shrink-0 text-[10px]">
                  {totalSucc > 0 && <span className="text-emerald-400 font-bold">✓{totalSucc}</span>}
                  {totalFail > 0 && <span className="text-red-400 font-bold">✗{totalFail}</span>}
                </div>
              )}

              {/* Aggregate status pill */}
              <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase border shrink-0 ${aggPill}`}>
                {group.aggStatus === "pending" ? "chờ" : group.aggStatus === "success" ? "OK" : "lỗi"}
              </span>
            </div>

            {/* ── Child rows (each khu) ── */}
            {isOpen && (
              <div className="divide-y divide-gray-800/40">
                {group.sessions.map((sess) => {
                  const succCnt = sess.results.filter((r) => r.status === "success").length;
                  const failCnt = sess.results.filter((r) => r.status === "failed").length;
                  const dur = sess.finishedAt
                    ? `${Math.round((sess.finishedAt - sess.sentAt) / 1000)}s`
                    : null;

                  const statusPill =
                    sess.status === "pending"
                      ? "bg-amber-900/60 text-amber-200 border-amber-700/40 animate-pulse"
                      : sess.status === "success"
                      ? "bg-emerald-900/60 text-emerald-200 border-emerald-700/40"
                      : "bg-red-900/60 text-red-200 border-red-700/40";

                  return (
                    <button
                      key={sess.sessionId}
                      className="w-full text-left pl-6 pr-3 py-2 flex items-center gap-2 hover:bg-gray-800/40 transition-colors bg-gray-900/30"
                      onClick={() => onSelect(sess)}
                    >
                      {/* KHU badge */}
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold border shrink-0 ${sess.deptColor}`}>
                        {sess.deptName}
                      </span>

                      {/* Device name */}
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] font-semibold text-gray-300 leading-tight truncate">{sess.deviceName}</p>
                        <p className="text-[9px] text-gray-600 leading-tight mt-0.5">
                          {sess.keywords.length} kw{dur ? ` · ${dur}` : ""}
                        </p>
                      </div>

                      {/* Result counts */}
                      {sess.results.length > 0 && (
                        <div className="flex gap-1 shrink-0 text-[10px]">
                          {succCnt > 0 && <span className="text-emerald-400 font-bold">✓{succCnt}</span>}
                          {failCnt > 0 && <span className="text-red-400 font-bold">✗{failCnt}</span>}
                        </div>
                      )}

                      {/* Status pill */}
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase border shrink-0 ${statusPill}`}>
                        {sess.status === "pending" ? "chờ" : sess.status === "success" ? "OK" : "lỗi"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Session detail modal ──────────────────────────────────────────────────────

function SessionDetailModal({
  session: sess,
  onClose,
}: {
  session: SessionRecord;
  onClose: () => void;
}) {
  const [expandedKw, setExpandedKw] = useState<string | null>(null);

  const succResults  = sess.results.filter((r) => r.status === "success");
  const failResults  = sess.results.filter((r) => r.status === "failed");
  const pendingKws   = sess.keywords.filter((kw) => !sess.results.some((r) => r.keyword === kw));

  const top1Cnt  = succResults.filter((r) => (r.topPosition ?? 999) === 1).length;
  const top3Cnt  = succResults.filter((r) => (r.topPosition ?? 999) <= 3).length;
  const top10Cnt = succResults.filter((r) => (r.topPosition ?? 999) <= 10).length;

  const avgRank = succResults.length > 0
    ? (succResults.reduce((a, r) => a + (r.topPosition ?? 0), 0) / succResults.length).toFixed(1)
    : null;

  const dur = sess.finishedAt
    ? `${Math.round((sess.finishedAt - sess.sentAt) / 1000)}s`
    : "đang chạy…";

  const sentTime = new Date(sess.sentAt).toLocaleTimeString("vi-VN", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  const statusIcon =
    sess.status === "pending" ? "⏳" :
    sess.status === "success" ? "✅" : "❌";

  const statusLabel =
    sess.status === "pending" ? "Đang xử lý" :
    sess.status === "success" ? "Hoàn thành"  : "Thất bại";

  const statusCls =
    sess.status === "pending" ? "text-amber-300" :
    sess.status === "success" ? "text-emerald-300" : "text-red-300";

  // All keywords in sent order, with their result (if any)
  const kwRows = sess.keywords.map((kw) => ({
    kw,
    result: sess.results.find((r) => r.keyword === kw) ?? null,
  }));

  return (
    /* backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      {/* modal */}
      <div
        className="relative bg-gray-950 border border-gray-800 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Modal header ── */}
        <div className="shrink-0 px-5 py-4 border-b border-gray-800/80 flex items-start gap-3">
          <span className={`text-[10px] px-2 py-1 rounded-full font-bold border shrink-0 mt-0.5 ${sess.deptColor}`}>
            {sess.deptName}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-[13px] font-bold text-gray-100">{sess.deviceName}</p>
              <span className={`text-[11px] font-semibold ${statusCls}`}>{statusIcon} {statusLabel}</span>
            </div>
            <p className="text-[10px] font-mono text-gray-600 mt-0.5 truncate">
              {sess.sessionId}
            </p>
            <p className="text-[10px] text-gray-600 mt-0.5">
              {sentTime} · {dur} · device: <span className="text-gray-500 font-mono">{sess.deviceId}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-gray-600 hover:text-gray-300 text-xl leading-none transition-colors"
          >
            ✕
          </button>
        </div>

        {/* ── Summary stats ── */}
        <div className="shrink-0 px-5 py-3 border-b border-gray-800/60 grid grid-cols-5 gap-2">
          <StatBox label="Tổng KW"  value={sess.keywords.length}       cls="text-gray-200" />
          <StatBox label="Thành công" value={succResults.length}        cls="text-emerald-300" />
          <StatBox label="Thất bại"  value={failResults.length}         cls={failResults.length ? "text-red-300" : "text-gray-600"} />
          <StatBox label="Top #1"    value={top1Cnt}                    cls={top1Cnt ? "text-yellow-300" : "text-gray-600"} />
          <StatBox label="Avg rank"  value={avgRank ? `#${avgRank}` : "—"} cls="text-blue-300" />
        </div>

        {/* ── Rank breakdown ── */}
        {succResults.length > 0 && (
          <div className="shrink-0 px-5 py-2 border-b border-gray-800/40 flex items-center gap-4 text-[10px]">
            <span className="text-gray-600 uppercase font-bold tracking-wider text-[9px]">Rank</span>
            <RankBadge label="Top 1"  count={top1Cnt}  total={sess.keywords.length} cls="text-yellow-400" />
            <RankBadge label="Top 3"  count={top3Cnt}  total={sess.keywords.length} cls="text-emerald-400" />
            <RankBadge label="Top 10" count={top10Cnt} total={sess.keywords.length} cls="text-blue-400" />
            {pendingKws.length > 0 && (
              <span className="ml-auto text-amber-400/70 animate-pulse text-[9px]">
                ⏳ {pendingKws.length} đang xử lý…
              </span>
            )}
          </div>
        )}

        {/* ── Failed section (if any) ── */}
        {failResults.length > 0 && (
          <div className="shrink-0 px-5 py-2.5 border-b border-red-900/30 bg-red-950/20">
            <p className="text-[9px] text-red-500 uppercase font-bold tracking-widest mb-1.5">
              ✗ Thất bại ({failResults.length})
            </p>
            <div className="space-y-1">
              {failResults.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="text-red-400 font-bold shrink-0">✗</span>
                  <span className="text-red-200 font-semibold">{r.keyword}</span>
                  {r.failReason && (
                    <span className="text-red-400/70 text-[10px] truncate">— {r.failReason}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Keyword results table ── */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {kwRows.length === 0 ? (
            <p className="text-[11px] text-gray-600 italic text-center py-8">Chưa có kết quả</p>
          ) : (
            <div className="divide-y divide-gray-800/30">
              {kwRows.map(({ kw, result }) => (
                <KeywordDetailRow
                  key={kw}
                  keyword={kw}
                  result={result}
                  expanded={expandedKw === kw}
                  onToggle={() => setExpandedKw(expandedKw === kw ? null : kw)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="shrink-0 px-5 py-2.5 border-t border-gray-800/60 flex items-center justify-between">
          <span className="text-[10px] text-gray-700">
            {sess.results.length}/{sess.keywords.length} keywords
            {sess.finishedAt && (
              <> · xong lúc {new Date(sess.finishedAt).toLocaleTimeString("vi-VN", {
                hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
              })}</>
            )}
          </span>
          <button
            onClick={onClose}
            className="text-[11px] px-3 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Stat box ─────────────────────────────────────────────────────────────────

function StatBox({ label, value, cls }: { label: string; value: number | string; cls: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 bg-gray-900/60 rounded-lg py-2">
      <span className={`text-[15px] font-bold tabular-nums ${cls}`}>{value}</span>
      <span className="text-[8px] text-gray-600 uppercase tracking-wider text-center leading-tight">{label}</span>
    </div>
  );
}

// ── Rank badge ────────────────────────────────────────────────────────────────

function RankBadge({ label, count, total, cls }: { label: string; count: number; total: number; cls: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-1.5">
      <span className={`font-bold tabular-nums ${cls}`}>{count}</span>
      <span className="text-gray-600">{label}</span>
      <span className="text-gray-700">({pct}%)</span>
    </div>
  );
}

// ── Keyword detail row (with expandable SERP) ─────────────────────────────────

function KeywordDetailRow({
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
  const isPending = result === null;
  const isOk      = result?.status === "success";
  const rank      = result ? (result.topPosition ?? result.serp?.[0]?.position ?? null) : null;

  const rankCls =
    rank == null    ? "text-gray-600" :
    rank === 1      ? "text-yellow-400 font-bold" :
    rank <= 3       ? "text-emerald-400 font-bold" :
    rank <= 10      ? "text-blue-400 font-semibold" :
                      "text-gray-500";

  const hasSerpData = result && result.serp && result.serp.length > 0;

  return (
    <div>
      <button
        className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors ${
          hasSerpData ? "hover:bg-gray-800/30 cursor-pointer" : "cursor-default"
        }`}
        onClick={hasSerpData ? onToggle : undefined}
      >
        {/* Status icon */}
        <span className={`text-[11px] font-bold shrink-0 w-4 text-center ${
          isPending ? "text-amber-500 animate-pulse" :
          isOk      ? "text-emerald-400" : "text-red-400"
        }`}>
          {isPending ? "⏳" : isOk ? "✓" : "✗"}
        </span>

        {/* Keyword */}
        <span className="flex-1 min-w-0 text-[12px] font-semibold text-gray-200 truncate">
          {keyword}
        </span>

        {/* Rank */}
        {rank != null && (
          <span className={`text-[11px] font-mono tabular-nums shrink-0 ${rankCls}`}>
            #{rank}
          </span>
        )}

        {/* Domain */}
        {isOk && result?.topDomain && (
          <span className="text-[10px] text-blue-400 font-mono shrink-0 max-w-[120px] truncate">
            {result.topDomain}
          </span>
        )}

        {/* Fail reason */}
        {!isPending && !isOk && result?.failReason && (
          <span className="text-[10px] text-red-400/80 shrink-0 max-w-[140px] truncate">
            {result.failReason}
          </span>
        )}

        {/* SERP count + expand arrow */}
        {hasSerpData && (
          <span className="text-[9px] text-gray-700 shrink-0 flex items-center gap-1">
            {result!.serp.length} kq
            <span>{expanded ? "▲" : "▼"}</span>
          </span>
        )}
      </button>

      {/* ── SERP list ── */}
      {expanded && hasSerpData && (
        <div className="bg-gray-900/60 border-t border-gray-800/30 px-5 py-2 space-y-1.5">
          {result!.serp.map((item) => (
            <SerpRow key={item.position} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── SERP result row ───────────────────────────────────────────────────────────

function SerpRow({ item }: { item: SerpItem }) {
  const posCls =
    item.position === 1  ? "bg-yellow-500/20 text-yellow-300 border-yellow-600/30" :
    item.position <= 3   ? "bg-emerald-500/20 text-emerald-300 border-emerald-600/30" :
    item.position <= 10  ? "bg-blue-500/20 text-blue-300 border-blue-600/30" :
                           "bg-gray-800/60 text-gray-500 border-gray-700/30";

  return (
    <div className="flex items-start gap-2.5 text-[10px]">
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
