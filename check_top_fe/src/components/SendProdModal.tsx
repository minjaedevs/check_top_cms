import { useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import { DEPTS } from "../constants/khu";
import type { Dept } from "../constants/khu";
import type { DeviceSerialized } from "../types";

interface Props { onClose: () => void }

type KhuResult = { ok: boolean; msg: string } | null;

// ── Device enriched with pool routing info ────────────────────────────────────
// Needed so each send goes to the correct connectionId (one per client process)
interface PoolDevice extends DeviceSerialized {
  connectionId: string;
  poolLabel: string; // display name for the pool column
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DOT_CLS: Record<string, string> = {
  idle:       "bg-gray-400",
  processing: "bg-blue-400 animate-pulse",
  failed:     "bg-red-500",
  recovering: "bg-amber-400 animate-pulse",
  done:       "bg-emerald-400",
  offline:    "bg-gray-700",
};

/**
 * Round-robin KHU assignment across ALL idle devices from ALL pools.
 *   idleDevices = [D0(pool1), D1(pool2), D2(pool1)]
 *   DEPTS = [A, B, C, D, E]
 *   → D0: [A, D]   D1: [B, E]   D2: [C]
 *
 * Returns map: deptId → PoolDevice
 */
function buildRoundRobin(
  depts: Dept[],
  idleDevices: PoolDevice[],
): Map<string, PoolDevice> {
  const result = new Map<string, PoolDevice>();
  if (!idleDevices.length) return result;
  depts.forEach((dept, i) => {
    result.set(dept.id, idleDevices[i % idleDevices.length]);
  });
  return result;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SendProdModal({ onClose }: Props) {
  const pools      = useStore((s) => s.pools);
  const addSession = useStore((s) => s.addSession);

  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Record<string, KhuResult>>({});

  // ── Flatten ALL idle devices across ALL pools ─────────────────────────────
  // Each device carries its connectionId so /api/send-keywords routes correctly
  const idleDevices = useMemo<PoolDevice[]>(() =>
    pools.flatMap((pool) =>
      pool.devices
        .filter((d) => d.status === "idle")
        .map((d): PoolDevice => ({
          ...d,
          connectionId: pool.connectionId,
          poolLabel: pool.labId || pool.connectionId.slice(0, 10),
        }))
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pools.map((p) => p.connectionId + p.devices.map((d) => d.deviceId + d.status).join(",")).join("|")],
  );

  // Round-robin (recomputed when idle list changes)
  const assignment = useMemo(
    () => buildRoundRobin(DEPTS, idleDevices),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idleDevices.map((d) => `${d.connectionId}:${d.deviceId}`).join(",")],
  );

  // Group KHUs by device for preview display
  const deviceGroups = useMemo(() => {
    const map = new Map<string, { device: PoolDevice; depts: Dept[] }>();
    for (const [deptId, device] of assignment) {
      const key = `${device.connectionId}:${device.deviceId}`;
      if (!map.has(key)) {
        map.set(key, { device, depts: [] });
      }
      const dept = DEPTS.find((d) => d.id === deptId);
      if (dept) map.get(key)!.depts.push(dept);
    }
    return [...map.values()];
  }, [assignment]);

  const totalKhu  = assignment.size;
  const totalKw   = DEPTS.filter((d) => assignment.has(d.id))
                         .reduce((s, d) => s + d.keywords.length, 0);
  const doneCount = Object.values(results).filter(Boolean).length;
  const isDone    = doneCount > 0 && doneCount === totalKhu;

  // ── Send one KHU to its assigned device ──────────────────────────────────
  async function sendOne(dept: Dept, device: PoolDevice, batchSendId: string): Promise<KhuResult> {
    try {
      const res = await fetch("/api/send-keywords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: device.connectionId, // routed per-device, not a global pool
          deviceId: device.deviceId,
          keywords: dept.keywords,
          proxy: dept.proxy ?? undefined,
          departmentId: dept.id,
          departmentName: dept.name,
        }),
      });
      const data = await res.json() as {
        ok?: boolean; error?: string; sent?: number; sessionId?: string
      };
      if (data.ok) {
        const sessionId = data.sessionId ?? `SESS-local-${Date.now()}`;
        addSession({
          sessionId, batchSendId,
          deptId: dept.id, deptName: dept.name, deptColor: dept.color,
          connectionId: device.connectionId, deviceId: device.deviceId,
          deviceName: device.name,
          keywords: dept.keywords,
          sentAt: Date.now(), status: "pending", results: [], finishedAt: null,
        });
        return { ok: true, msg: `✓ ${data.sent} kw` };
      }
      return { ok: false, msg: data.error ?? "error" };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  }

  // ── Send all KHUs concurrently ────────────────────────────────────────────
  async function handleSendProd() {
    if (!totalKhu || sending) return;
    setSending(true);
    setResults({});

    const batchSendId = `prod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    await Promise.all(
      DEPTS.filter((d) => assignment.has(d.id)).map(async (dept) => {
        const device = assignment.get(dept.id)!;
        const r = await sendOne(dept, device, batchSendId);
        setResults((prev) => ({ ...prev, [dept.id]: r }));
      }),
    );

    setSending(false);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-950 border border-gray-800 rounded-2xl w-full max-w-lg flex flex-col shadow-2xl"
        style={{ maxHeight: "min(90vh, 700px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
          <div>
            <h2 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
              <span className="text-emerald-400">▶</span> Gửi Keywords – Prod
            </h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Round-robin · tất cả client · chỉ device IDLE
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition-colors text-lg"
          >
            ×
          </button>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-5 space-y-5">

          {/* No idle devices anywhere */}
          {idleDevices.length === 0 && (
            <div className="flex items-center justify-center h-24 border border-dashed border-amber-800/30 bg-amber-950/10 rounded-xl">
              <div className="text-center">
                <p className="text-[11px] text-amber-600 font-medium">Không có device IDLE</p>
                <p className="text-[10px] text-gray-600 mt-0.5">
                  {pools.length} pool · {pools.reduce((n, p) => n + p.devices.length, 0)} device đã kết nối
                </p>
              </div>
            </div>
          )}

          {/* Assignment preview */}
          {idleDevices.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                  Phân công ({idleDevices.length} device · {totalKhu} KHU · {totalKw} kw)
                </label>
              </div>

              <div className="rounded-xl border border-gray-800 overflow-hidden divide-y divide-gray-800/60">
                {deviceGroups.map(({ device, depts }) => (
                  <div key={`${device.connectionId}:${device.deviceId}`} className="px-4 py-3 bg-gray-900/30">

                    {/* Device row */}
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${DOT_CLS[device.status] ?? "bg-gray-400"}`} />
                      <span className="text-xs font-bold text-gray-100">
                        {device.name || device.deviceId.slice(0, 14)}
                      </span>
                      {/* Pool badge — shows which client this device belongs to */}
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-800/80 text-gray-500 border border-gray-700/40">
                        {device.poolLabel}
                      </span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700/40 uppercase">
                        {device.status}
                      </span>
                      <span className="ml-auto text-[10px] text-gray-600">
                        {depts.length} KHU · {depts.reduce((s, d) => s + d.keywords.length, 0)} kw
                      </span>
                    </div>

                    {/* KHU chips for this device */}
                    <div className="flex flex-wrap gap-1.5 pl-4">
                      {depts.map((dept) => {
                        const res = results[dept.id];
                        return (
                          <div key={dept.id} className="flex items-center gap-1">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${dept.color}`}>
                              {dept.name}
                            </span>
                            <span className="text-[9px] text-gray-600">
                              {dept.keywords.length}kw
                            </span>
                            {/* Result badge — real-time per KHU */}
                            {res && (
                              <span className={`text-[9px] font-bold ${res.ok ? "text-emerald-400" : "text-red-400"}`}>
                                {res.msg}
                              </span>
                            )}
                            {sending && !res && (
                              <span className="text-[9px] text-gray-600 animate-pulse">…</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* Round-robin note */}
              <p className="text-[10px] text-gray-700 mt-2 pl-1">
                Round-robin: {DEPTS.map((d, i) => {
                  const dev = idleDevices[i % idleDevices.length];
                  return `${d.name}→${dev?.name?.split(" ")[0] ?? "?"}`;
                }).join("  ")}
              </p>
            </div>
          )}

          {/* Done summary banner */}
          {isDone && (
            <div className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold border ${
              Object.values(results).every((r) => r?.ok)
                ? "bg-emerald-950/30 border-emerald-800/40 text-emerald-300"
                : "bg-amber-950/30 border-amber-800/40 text-amber-300"
            }`}>
              {Object.values(results).every((r) => r?.ok)
                ? `✓ Đã gửi thành công ${totalKhu} KHU — ${totalKw} keywords`
                : `⚠ Hoàn thành với lỗi — kiểm tra từng KHU`}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="shrink-0 border-t border-gray-800 px-6 py-4 flex items-center justify-between bg-gray-900/30 rounded-b-2xl">
          <div className="text-[11px] text-gray-600">
            {idleDevices.length === 0 && "Không có device IDLE"}
            {idleDevices.length > 0 && !isDone && !sending && (
              <span>{pools.length} pool · {idleDevices.length} device · {totalKhu} KHU · {totalKw} keywords</span>
            )}
            {sending && (
              <span className="text-amber-400 animate-pulse">Đang gửi {doneCount}/{totalKhu}…</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-xl transition-colors"
            >
              Đóng
            </button>
            <button
              onClick={handleSendProd}
              disabled={!totalKhu || sending || isDone}
              className="flex items-center gap-2 px-5 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl transition-colors"
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
                <path d="M2 2l8 4-8 4V2z"/>
              </svg>
              {sending ? `Đang gửi… (${doneCount}/${totalKhu})` : `Gửi Prod (${totalKhu} KHU)`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
