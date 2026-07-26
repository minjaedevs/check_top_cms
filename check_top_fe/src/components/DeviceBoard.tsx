import { useStore } from "../store/useStore";
import { DeviceColumn } from "./DeviceColumn";

export function DeviceBoard() {
  const pools    = useStore((s) => s.pools);
  const wsStatus = useStore((s) => s.wsStatus);

  // ── Loading state ────────────────────────────────────────────────────────

  if (wsStatus === "connecting") {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="relative mx-auto w-10 h-10 mb-4">
            <div className="absolute inset-0 rounded-full border-2 border-blue-500/20" />
            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-blue-500 animate-spin" />
          </div>
          <p className="text-sm font-medium text-gray-300">Đang kết nối server…</p>
          <p className="text-xs text-gray-600 mt-1">ws://localhost:3007/ws/dashboard</p>
        </div>
      </div>
    );
  }

  // ── Empty state ──────────────────────────────────────────────────────────

  if (pools.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-gray-800/60 border border-gray-700/40 flex items-center justify-center mx-auto mb-5">
            <span className="text-3xl">📱</span>
          </div>
          <p className="text-base font-semibold text-gray-200 mb-1.5">Chưa có thiết bị nào</p>
          <p className="text-sm text-gray-500 mb-4">
            Chạy app với biến môi trường:
          </p>
          <div className="bg-gray-900 border border-gray-700/60 rounded-xl px-4 py-3 text-left">
            <p className="text-[11px] text-gray-500 mb-1 font-semibold uppercase tracking-wide">SignalR URL</p>
            <code className="text-xs text-blue-300 font-mono break-all">
              ws://localhost:3007/hubs/mobile-check
            </code>
          </div>
        </div>
      </div>
    );
  }

  // ── Pool list ────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto overflow-x-auto p-4 space-y-6">
      {pools.map((pool) => {
        const busyCount = pool.devices.filter((d) => d.status === "processing").length;
        const failCount = pool.devices.filter((d) => d.status === "failed").length;

        return (
          <section key={pool.connectionId}>
            {/* ── Pool header ── */}
            <div className="flex items-center gap-3 mb-3 px-1">
              {/* Status dot */}
              <div className="relative">
                <span className="block w-2.5 h-2.5 rounded-full bg-emerald-400" />
                <span className="absolute inset-0 rounded-full bg-emerald-400/30 animate-ping" />
              </div>

              {/* Pool name */}
              <span className="text-sm font-bold text-gray-100 tracking-tight">
                {pool.labId || pool.machineId || "Pool"}
              </span>

              {/* Connection ID (truncated) */}
              <span className="text-[11px] text-gray-600 font-mono hidden sm:block truncate max-w-[160px]">
                {pool.connectionId.slice(0, 20)}…
              </span>

              {/* Device count badges */}
              <div className="flex items-center gap-1.5 ml-1">
                <Badge color="gray">{pool.devices.length} devices</Badge>
                {busyCount > 0 && <Badge color="blue">{busyCount} active</Badge>}
                {failCount  > 0 && <Badge color="red">{failCount} failed</Badge>}
              </div>

              {/* Connected time */}
              <span className="ml-auto text-[11px] text-gray-600">
                {formatAge(pool.connectedAt)}
              </span>
            </div>

            {/* ── Device cards ── */}
            {pool.devices.length === 0 ? (
              <div className="flex items-center justify-center h-24 border border-dashed border-gray-800 rounded-xl">
                <p className="text-sm text-gray-600 italic">Pool này chưa có device</p>
              </div>
            ) : (
              <div className="flex gap-3 overflow-x-auto pb-1">
                {pool.devices.map((device) => (
                  <DeviceColumn
                    key={device.deviceId}
                    connectionId={pool.connectionId}
                    device={device}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function Badge({
  children, color,
}: { children: React.ReactNode; color: "gray" | "blue" | "red" | "green" }) {
  const cls = {
    gray:  "bg-gray-800 text-gray-400 border-gray-700/40",
    blue:  "bg-blue-900/40 text-blue-300 border-blue-700/30",
    red:   "bg-red-900/40 text-red-400 border-red-700/30",
    green: "bg-emerald-900/40 text-emerald-400 border-emerald-700/30",
  }[color];
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cls}`}>
      {children}
    </span>
  );
}

function formatAge(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60)   return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}
