import { useState } from "react";
import { useStore } from "../store/useStore";
import { SendKeywordsModal } from "./SendKeywordsModal";
import { SendProdModal } from "./SendProdModal";

// ── WS status config ────────────────────────────────────────────────────────

const WS_DOT: Record<string, string> = {
  connecting: "bg-amber-400 animate-pulse",
  open:       "bg-emerald-400",
  closed:     "bg-gray-500",
  error:      "bg-red-500",
};
const WS_LABEL: Record<string, string> = {
  connecting: "Connecting",
  open:       "Live",
  closed:     "Offline",
  error:      "Error",
};
const WS_TEXT: Record<string, string> = {
  connecting: "text-amber-400",
  open:       "text-emerald-400",
  closed:     "text-gray-400",
  error:      "text-red-400",
};

// ── Component ───────────────────────────────────────────────────────────────

export function Header() {
  const wsStatus = useStore((s) => s.wsStatus);
  const stats    = useStore((s) => s.stats);
  const pools    = useStore((s) => s.pools);
  const sessions = useStore((s) => s.sessions);
  const [showModal, setShowModal]     = useState(false);
  const [showProdModal, setShowProdModal] = useState(false);

  const totalDevices   = pools.reduce((a, p) => a + p.devices.length, 0);
  const busyDevices    = pools.reduce((a, p) => a + p.devices.filter((d) => d.status === "processing").length, 0);
  const failedDevices  = pools.reduce((a, p) => a + p.devices.filter((d) => d.status === "failed").length, 0);
  const offlineDevices = pools.reduce((a, p) => a + p.devices.filter((d) => d.status === "offline").length, 0);
  const pendingSessions = sessions.filter((s) => s.status === "pending").length;

  const successRate = stats.totalJobs > 0
    ? Math.round((stats.successJobs / stats.totalJobs) * 100)
    : null;

  return (
    <>
      <header className="shrink-0 bg-gray-950 border-b border-gray-800/80 select-none">

        {/* ── Row 1: Brand + WS + Action ────────────────────────────────── */}
        <div className="flex items-center gap-3 px-5 pt-3.5 pb-2.5">

          {/* Brand */}
          <div className="flex items-center gap-2.5 mr-1">
            <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-900/40">
              <span className="text-white text-xs font-black">CT</span>
            </div>
            <div>
              <p className="text-sm font-bold text-white leading-none tracking-tight">Check Top</p>
              <p className="text-[10px] text-gray-500 leading-none mt-0.5">Dashboard</p>
            </div>
          </div>

          {/* Separator */}
          <div className="w-px h-8 bg-gray-800 mx-1" />

          {/* WS status */}
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full shrink-0 ${WS_DOT[wsStatus] ?? "bg-gray-500"}`} />
            <span className={`text-xs font-semibold ${WS_TEXT[wsStatus] ?? "text-gray-400"}`}>
              {WS_LABEL[wsStatus] ?? wsStatus}
            </span>
          </div>

          <div className="flex-1" />

          {/* Send Prod CTA — one-click round-robin */}
          <button
            onClick={() => setShowProdModal(true)}
            disabled={pools.length === 0}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl transition-all duration-150 shadow-md shadow-emerald-900/30"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M2 2l8 4-8 4V2z"/>
            </svg>
            Send Prod
          </button>

          {/* Send Keywords CTA */}
          <button
            onClick={() => setShowModal(true)}
            disabled={pools.length === 0}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl transition-all duration-150 shadow-md shadow-blue-900/30"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M2 2l8 4-8 4V2z"/>
            </svg>
            Gửi Keywords
          </button>
        </div>

        {/* ── Row 2: Stats bar ─────────────────────────────────────────── */}
        <div className="flex items-center gap-1.5 px-5 pb-3 flex-wrap">

          {/* Pools */}
          <StatGroup>
            <StatItem icon="⬡" label="Pools" value={pools.length} valueClass="text-blue-300" />
          </StatGroup>

          <Pipe />

          {/* Devices */}
          <StatGroup>
            <StatItem
              label="Active"
              value={busyDevices}
              valueClass={busyDevices > 0 ? "text-blue-300 tabular" : "text-gray-500 tabular"}
              pulse={busyDevices > 0}
            />
            <span className="text-gray-700 text-xs">/</span>
            <StatItem label="Total" value={totalDevices} valueClass="text-gray-300 tabular" />
            {failedDevices > 0 && (
              <>
                <span className="text-gray-700 text-xs">·</span>
                <StatItem label="Failed" value={failedDevices} valueClass="text-red-400 tabular" />
              </>
            )}
            {offlineDevices > 0 && (
              <>
                <span className="text-gray-700 text-xs">·</span>
                <StatItem label="Offline" value={offlineDevices} valueClass="text-gray-500 tabular" />
              </>
            )}
          </StatGroup>

          <Pipe />

          {/* Jobs */}
          <StatGroup>
            <StatItem label="Jobs" value={stats.totalJobs} valueClass="text-gray-300 tabular" />
            <span className="text-gray-700 text-xs">·</span>
            <StatItem label="OK" value={stats.successJobs} valueClass="text-emerald-400 tabular" />
            <span className="text-gray-700 text-xs">·</span>
            <StatItem label="Fail" value={stats.failedJobs} valueClass="text-red-400 tabular" />
            {stats.retryJobs > 0 && (
              <>
                <span className="text-gray-700 text-xs">·</span>
                <StatItem label="Retry" value={stats.retryJobs} valueClass="text-amber-400 tabular" />
              </>
            )}
            {successRate != null && (
              <>
                <span className="text-gray-700 text-xs">·</span>
                <span className={`text-xs font-bold tabular ${successRate >= 80 ? "text-emerald-400" : successRate >= 50 ? "text-amber-400" : "text-red-400"}`}>
                  {successRate}%
                </span>
              </>
            )}
          </StatGroup>

          <Pipe />

          {/* Keywords */}
          <StatGroup>
            <StatItem label="KW OK" value={stats.successKeywords} valueClass="text-emerald-400 tabular" />
            <span className="text-gray-700 text-xs">·</span>
            <StatItem label="KW Fail" value={stats.failedKeywords} valueClass="text-red-400 tabular" />
          </StatGroup>

          {sessions.length > 0 && (
            <>
              <Pipe />
              {/* Sessions */}
              <StatGroup>
                <StatItem label="Phiên" value={sessions.length} valueClass="text-gray-300 tabular" />
                {pendingSessions > 0 && (
                  <>
                    <span className="text-gray-700 text-xs">·</span>
                    <StatItem label="Đang chạy" value={pendingSessions} valueClass="text-amber-400 tabular" pulse />
                  </>
                )}
              </StatGroup>
            </>
          )}
        </div>
      </header>

      {showModal     && <SendKeywordsModal onClose={() => setShowModal(false)} />}
      {showProdModal && <SendProdModal    onClose={() => setShowProdModal(false)} />}
    </>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function StatGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5 bg-gray-900/60 rounded-lg px-2.5 py-1 border border-gray-800/60">
      {children}
    </div>
  );
}

function StatItem({
  icon, label, value, valueClass, pulse = false,
}: {
  icon?: string; label: string; value: number;
  valueClass: string; pulse?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-1">
      {icon && <span className="text-gray-600 text-[10px]">{icon}</span>}
      <span className={`text-sm font-bold leading-none ${valueClass} ${pulse ? "animate-pulse" : ""}`}>
        {value}
      </span>
      <span className="text-[10px] text-gray-600 leading-none">{label}</span>
    </span>
  );
}

function Pipe() {
  return <div className="w-px h-4 bg-gray-800 mx-0.5 self-center" />;
}
