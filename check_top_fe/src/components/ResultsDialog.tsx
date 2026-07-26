import { useEffect, useState } from "react";
import type { KeywordResult, SessionRecord, SerpItem } from "../types";

interface Props {
  deviceName: string;
  deviceId:   string;
  sessions:   SessionRecord[];
  onClose:    () => void;
}

export function ResultsDialog({ deviceName, deviceId, sessions, onClose }: Props) {
  const [expandedKw, setExpandedKw] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // Aggregate totals across all sessions for this device
  const allResults  = sessions.flatMap((s) => s.results);
  const totalSucc   = allResults.filter((r) => r.status === "success").length;
  const totalFail   = allResults.filter((r) => r.status === "failed").length;
  const successRate = allResults.length > 0
    ? Math.round((totalSucc / allResults.length) * 100) : 0;

  const bestRank = allResults.reduce<number | null>((b, r) => {
    const pos = r.topPosition ?? r.serp[0]?.position ?? null;
    if (pos == null) return b;
    return b == null || pos < b ? pos : b;
  }, null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-950 border border-gray-800 rounded-2xl w-full max-w-3xl flex flex-col shadow-2xl"
        style={{ maxHeight: "min(92vh, 820px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center gap-4 px-6 py-4 border-b border-gray-800 shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-white tracking-tight truncate">
              {deviceName || deviceId}
            </h2>
            <p className="text-[10px] font-mono text-gray-600 mt-0.5 truncate">{deviceId}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {bestRank != null && (
              <span className={`px-2.5 py-1 rounded-lg border text-xs font-bold ${
                bestRank === 1 ? "bg-yellow-900/40 text-yellow-300 border-yellow-700/30" :
                bestRank <= 3  ? "bg-emerald-900/40 text-emerald-300 border-emerald-700/30" :
                                 "bg-blue-900/40 text-blue-300 border-blue-700/30"
              }`}>
                Best #{bestRank}
              </span>
            )}
            <span className="px-2.5 py-1 rounded-lg bg-emerald-900/30 text-emerald-400 border border-emerald-800/30 text-xs font-bold">
              ✓ {totalSucc}
            </span>
            <span className="px-2.5 py-1 rounded-lg bg-red-900/30 text-red-400 border border-red-800/30 text-xs font-bold">
              ✗ {totalFail}
            </span>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition-colors text-lg shrink-0"
          >
            ×
          </button>
        </div>

        {/* ── Sessions body ── */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {sessions.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-600 text-sm italic">
              Chưa có kết quả
            </div>
          ) : (
            <div className="divide-y divide-gray-800/60">
              {sessions.map((sess) => (
                <SessionSection
                  key={sess.sessionId}
                  session={sess}
                  expandedKw={expandedKw}
                  onToggleKw={(kw) => setExpandedKw(expandedKw === kw ? null : kw)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="shrink-0 border-t border-gray-800 px-6 py-3 flex items-center justify-between bg-gray-900/30 rounded-b-2xl">
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-gray-600">
              {allResults.length} kết quả · {sessions.length} phiên
            </span>
            {allResults.length > 0 && (
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-24 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                    style={{ width: `${successRate}%` }}
                  />
                </div>
                <span className={`text-[11px] font-bold tabular ${
                  successRate >= 80 ? "text-emerald-400" :
                  successRate >= 50 ? "text-amber-400"   : "text-red-400"
                }`}>
                  {successRate}%
                </span>
              </div>
            )}
          </div>
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

// ── Per-session section ────────────────────────────────────────────────────────

function SessionSection({
  session: sess,
  expandedKw,
  onToggleKw,
}: {
  session: SessionRecord;
  expandedKw: string | null;
  onToggleKw: (kw: string) => void;
}) {
  const succCnt = sess.results.filter((r) => r.status === "success").length;
  const failCnt = sess.results.filter((r) => r.status === "failed").length;

  const top1Cnt  = sess.results.filter((r) => (r.topPosition ?? 999) === 1).length;
  const top3Cnt  = sess.results.filter((r) => (r.topPosition ?? 999) <= 3).length;
  const top10Cnt = sess.results.filter((r) => (r.topPosition ?? 999) <= 10).length;

  const t = new Date(sess.sentAt).toLocaleTimeString("vi-VN", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const dur = sess.finishedAt
    ? `${Math.round((sess.finishedAt - sess.sentAt) / 1000)}s`
    : null;

  const statusCls =
    sess.status === "pending"
      ? "text-amber-300 border-amber-700/30 bg-amber-900/40"
      : sess.status === "success"
      ? "text-emerald-300 border-emerald-700/30 bg-emerald-900/40"
      : "text-red-300 border-red-700/30 bg-red-900/40";

  // Map all sent keywords to their result (may be null if still pending)
  const kwRows = sess.keywords.map((kw) => ({
    kw,
    result: sess.results.find((r) => r.keyword === kw) ?? null,
  }));

  return (
    <div>
      {/* Session header */}
      <div className="flex items-center gap-3 px-6 py-3 bg-gray-900/50 sticky top-0 z-10">
        {/* KHU badge */}
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border shrink-0 ${sess.deptColor}`}>
          {sess.deptName}
        </span>
        {/* Time */}
        <span className="text-[11px] text-gray-500 font-mono shrink-0">
          {t}{dur ? ` · ${dur}` : ""}
        </span>
        {/* Stats */}
        <div className="flex items-center gap-2 text-[10px]">
          {succCnt > 0 && <span className="text-emerald-400 font-bold">✓{succCnt}</span>}
          {failCnt > 0 && <span className="text-red-400 font-bold">✗{failCnt}</span>}
          {sess.keywords.length - sess.results.length > 0 && (
            <span className="text-amber-400/70 animate-pulse">
              ⏳{sess.keywords.length - sess.results.length}
            </span>
          )}
        </div>
        {/* Rank breakdown */}
        {succCnt > 0 && (
          <div className="flex items-center gap-2 text-[10px] ml-auto">
            {top1Cnt  > 0 && <span className="text-yellow-400  font-bold">#{1}×{top1Cnt}</span>}
            {top3Cnt  > top1Cnt && (
              <span className="text-emerald-400 font-bold">top3×{top3Cnt}</span>
            )}
            {top10Cnt > top3Cnt && (
              <span className="text-blue-400">top10×{top10Cnt}</span>
            )}
          </div>
        )}
        {/* Status pill */}
        <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold uppercase shrink-0 ${statusCls}`}>
          {sess.status === "pending" ? "chờ" : sess.status === "success" ? "OK" : "lỗi"}
        </span>
      </div>

      {/* Keyword rows */}
      <div className="divide-y divide-gray-800/30">
        {kwRows.map(({ kw, result }) => {
          const uid = `${sess.sessionId}:${kw}`;
          return (
            <KeywordRow
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
}

// ── Keyword row with expandable SERP ─────────────────────────────────────────

function KeywordRow({
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
  const hasSerpData = result && result.serp && result.serp.length > 0;

  const rankCls =
    rank == null  ? "text-gray-600" :
    rank === 1    ? "text-yellow-400 font-bold" :
    rank <= 3     ? "text-emerald-400 font-bold" :
    rank <= 10    ? "text-blue-400 font-semibold" :
                    "text-gray-500";

  return (
    <div>
      <div
        className={`flex items-center gap-3 px-6 py-2.5 transition-colors ${
          hasSerpData ? "hover:bg-gray-900/40 cursor-pointer" : ""
        } ${expanded ? "bg-gray-900/30" : ""}`}
        onClick={hasSerpData ? onToggle : undefined}
      >
        {/* Status */}
        <span className={`text-[11px] font-bold w-4 text-center shrink-0 ${
          isPending ? "text-amber-500 animate-pulse" :
          isOk      ? "text-emerald-400"             : "text-red-400"
        }`}>
          {isPending ? "⏳" : isOk ? "✓" : "✗"}
        </span>

        {/* Keyword */}
        <span className="flex-1 text-xs font-semibold text-gray-100 truncate">{keyword}</span>

        {/* Rank */}
        {rank != null && (
          <span className={`text-xs font-mono tabular shrink-0 ${rankCls}`}>#{rank}</span>
        )}

        {/* Top domain */}
        {isOk && result?.topDomain && (
          <span className="text-[10px] text-blue-400 font-mono shrink-0 max-w-[160px] truncate">
            {result.topDomain}
          </span>
        )}

        {/* Fail reason */}
        {!isPending && !isOk && result?.failReason && (
          <span className="text-[10px] text-red-400/80 shrink-0 max-w-[160px] truncate">
            {result.failReason}
          </span>
        )}

        {/* SERP expand indicator */}
        {hasSerpData && (
          <span className="text-[9px] text-gray-600 shrink-0 flex items-center gap-0.5">
            {result!.serp.length}kq {expanded ? "▲" : "▼"}
          </span>
        )}
      </div>

      {/* Full SERP list */}
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

// ── SERP result row ───────────────────────────────────────────────────────────

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
