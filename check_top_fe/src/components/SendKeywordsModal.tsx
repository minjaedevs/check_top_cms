import { useState } from "react";
import { useStore } from "../store/useStore";
import { DEPTS } from "../constants/khu";
import type { Dept } from "../constants/khu";
import type { DeviceSerialized } from "../types";

interface Props { onClose: () => void }
type RowResult = { ok: boolean; msg: string } | null;

// ── Status chip for device ────────────────────────────────────────────────────

const DEV_STATUS_CLS: Record<string, string> = {
  idle:       "bg-gray-800 text-gray-400 border-gray-700/40",
  processing: "bg-blue-900/50 text-blue-300 border-blue-700/40",
  failed:     "bg-red-900/50 text-red-300 border-red-700/40",
  recovering: "bg-amber-900/50 text-amber-300 border-amber-700/40",
  done:       "bg-emerald-900/50 text-emerald-300 border-emerald-700/40",
  offline:    "bg-gray-900/60 text-gray-600 border-gray-800/40",
};
const DEV_DOT_CLS: Record<string, string> = {
  idle:       "bg-gray-500",
  processing: "bg-blue-400 animate-pulse",
  failed:     "bg-red-500",
  recovering: "bg-amber-400 animate-pulse",
  done:       "bg-emerald-400",
  offline:    "bg-gray-700",
};

/** True if device should not receive new work */
function isDeviceBusy(status: string): boolean {
  return status === "processing" || status === "recovering" || status === "offline";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SendKeywordsModal({ onClose }: Props) {
  const pools      = useStore((s) => s.pools);
  const addSession = useStore((s) => s.addSession);

  const [connectionId, setConnectionId] = useState("");
  const [proxy, setProxy]               = useState("");
  const [assignments, setAssignments]   = useState<Record<string, string>>({});
  const [rowResults, setRowResults]     = useState<Record<string, RowResult>>({});
  const [sendingAll, setSendingAll]     = useState(false);
  const [sendingRow, setSendingRow]     = useState<string | null>(null);

  const selectedPool = pools.find((p) => p.connectionId === connectionId);
  const devices: DeviceSerialized[] = selectedPool?.devices ?? [];

  function assign(deptId: string, devId: string) {
    setAssignments((p) => ({ ...p, [deptId]: devId }));
    setRowResults((p) => ({ ...p, [deptId]: null }));
  }

  function handleAutoAssign() {
    if (!devices.length) return;
    const next = { ...assignments };
    let idx = 0;
    for (const d of DEPTS) {
      if (!next[d.id] && idx < devices.length) {
        next[d.id] = devices[idx].deviceId;
        idx++;
      }
    }
    setAssignments(next);
    setRowResults({});
  }

  async function sendKhu(dept: Dept, batchSendId: string): Promise<RowResult> {
    const deviceId = assignments[dept.id];
    if (!connectionId || !deviceId) return { ok: false, msg: "Chọn pool và device" };

    // Proxy priority: per-KHU configured proxy > manual modal input
    const effectiveProxy = dept.proxy || proxy || undefined;

    try {
      const res  = await fetch("/api/send-keywords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId, deviceId,
          keywords: dept.keywords,
          proxy: effectiveProxy,
          departmentId: dept.id,
          departmentName: dept.name,
        }),
      });
      const data = await res.json() as { ok?: boolean; error?: string; sent?: number; sessionId?: string };
      if (data.ok) {
        const sessionId  = data.sessionId ?? `SESS-local-${Date.now()}`;
        const deviceName = devices.find((d) => d.deviceId === deviceId)?.name ?? deviceId;
        addSession({
          sessionId, batchSendId,
          deptId: dept.id, deptName: dept.name, deptColor: dept.color,
          connectionId, deviceId, deviceName,
          keywords: dept.keywords,
          sentAt: Date.now(), status: "pending", results: [], finishedAt: null,
        });
        return { ok: true, msg: `${data.sent} kw · ${sessionId.slice(0, 14)}` };
      }
      return { ok: false, msg: data.error ?? "unknown error" };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  }

  async function handleSendOne(dept: Dept) {
    setSendingRow(dept.id);
    const batchSendId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const r = await sendKhu(dept, batchSendId);
    setRowResults((p) => ({ ...p, [dept.id]: r }));
    setSendingRow(null);
  }

  async function handleSendAll() {
    const toSend = DEPTS.filter((d) => assignments[d.id]);
    if (!toSend.length) return;
    // All khu in one "Gửi tất cả" share the same batchSendId
    const batchSendId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setSendingAll(true);
    setRowResults({});
    for (const dept of toSend) {
      const r = await sendKhu(dept, batchSendId);
      setRowResults((p) => ({ ...p, [dept.id]: r }));
    }
    setSendingAll(false);
  }

  const assignedCount = DEPTS.filter((d) => assignments[d.id]).length;
  const allOk = assignedCount > 0 && DEPTS.filter((d) => assignments[d.id]).every((d) => rowResults[d.id]?.ok);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-950 border border-gray-800 rounded-2xl w-full max-w-2xl flex flex-col shadow-2xl"
        style={{ maxHeight: "min(90vh, 800px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Modal header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
          <div>
            <h2 className="text-sm font-bold text-white tracking-tight">Gửi Keywords theo KHU</h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Chọn pool → gán device → gửi từng khu hoặc tất cả cùng lúc
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

          {/* Pool + Proxy */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5">
                Pool
              </label>
              <select
                className="w-full bg-gray-900 border border-gray-800 hover:border-gray-700 focus:border-blue-600 rounded-xl px-3 py-2.5 text-xs text-gray-200 focus:outline-none transition-colors cursor-pointer"
                value={connectionId}
                onChange={(e) => { setConnectionId(e.target.value); setAssignments({}); setRowResults({}); }}
              >
                <option value="">— chọn pool —</option>
                {pools.map((p) => (
                  <option key={p.connectionId} value={p.connectionId}>
                    {p.labId || p.connectionId.slice(0, 16)} · {p.devices.length}dev
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5">
                Proxy <span className="normal-case font-normal text-gray-700">(override KHU mặc định)</span>
              </label>
              <input
                type="text"
                className="w-full bg-gray-900 border border-gray-800 hover:border-gray-700 focus:border-blue-600 rounded-xl px-3 py-2.5 text-xs text-gray-200 font-mono placeholder-gray-700 focus:outline-none transition-colors"
                placeholder="Để trống → dùng proxy của KHU"
                value={proxy}
                onChange={(e) => setProxy(e.target.value)}
              />
            </div>
          </div>

          {/* KHU table */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                Gán Device cho từng KHU
              </label>
              {connectionId && devices.length > 0 && (
                <button
                  onClick={handleAutoAssign}
                  className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-blue-400 border border-gray-700 transition-colors"
                >
                  Auto-assign
                </button>
              )}
            </div>

            {/* No pool selected */}
            {!connectionId && (
              <div className="flex items-center justify-center h-24 border border-dashed border-gray-800 rounded-xl">
                <p className="text-[11px] text-gray-700">← Chọn pool trước</p>
              </div>
            )}

            {/* No devices */}
            {connectionId && devices.length === 0 && (
              <div className="flex items-center justify-center h-24 border border-dashed border-amber-800/30 bg-amber-950/10 rounded-xl">
                <p className="text-[11px] text-amber-600">Pool này chưa có device</p>
              </div>
            )}

            {/* Table */}
            {connectionId && devices.length > 0 && (
              <div className="rounded-xl border border-gray-800 overflow-hidden">
                {/* Head */}
                <div className="grid grid-cols-[88px_1fr_156px_108px] bg-gray-900 border-b border-gray-800 px-4 py-2 text-[9px] text-gray-600 font-bold uppercase tracking-widest gap-3">
                  <span>KHU</span>
                  <span>Keywords</span>
                  <span>Device</span>
                  <span className="text-right">Gửi</span>
                </div>

                {/* Rows */}
                {DEPTS.map((dept) => {
                  const devId      = assignments[dept.id] ?? "";
                  const result     = rowResults[dept.id];
                  const isSending  = sendingRow === dept.id || (sendingAll && !!devId);
                  const assignedDev = devId ? devices.find((d) => d.deviceId === devId) : null;
                  const devBusy    = assignedDev ? isDeviceBusy(assignedDev.status) : false;

                  const rowBg =
                    result?.ok === true  ? "bg-emerald-950/20" :
                    result?.ok === false ? "bg-red-950/20" :
                    "hover:bg-gray-900/40";

                  return (
                    <div
                      key={dept.id}
                      className={`grid grid-cols-[88px_1fr_156px_108px] gap-3 px-4 py-3 border-t border-gray-800/60 items-center transition-colors ${rowBg}`}
                    >
                      {/* KHU */}
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border inline-block text-center ${dept.color}`}>
                        {dept.name}
                      </span>

                      {/* Keywords */}
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-gray-300">{dept.keywords.length} keywords</p>
                        <p className="text-[10px] text-gray-700 truncate mt-0.5">
                          {dept.keywords.slice(0, 3).join(", ")}{dept.keywords.length > 3 ? "…" : ""}
                        </p>
                      </div>

                      {/* Device dropdown */}
                      <div className="min-w-0">
                        <select
                          className={`w-full bg-gray-900 border rounded-lg px-2 py-1.5 text-[11px] focus:outline-none transition-colors cursor-pointer ${
                            devId
                              ? "border-blue-700/60 text-gray-100 focus:border-blue-500"
                              : "border-gray-800 text-gray-600 focus:border-gray-600"
                          }`}
                          value={devId}
                          onChange={(e) => assign(dept.id, e.target.value)}
                          disabled={!connectionId || !devices.length}
                        >
                          <option value="">— no device —</option>
                          {devices.map((d) => (
                            <option key={d.deviceId} value={d.deviceId}>
                              {d.name || d.deviceId.slice(0, 12)} [{d.status}]
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Send button + result */}
                      <div className="flex flex-col items-end gap-1">
                        <button
                          onClick={() => handleSendOne(dept)}
                          disabled={!devId || isSending || sendingAll}
                          title={devBusy ? `Device đang ${assignedDev?.status} — gửi sẽ xếp hàng` : undefined}
                          className={`px-3 py-1 text-[10px] font-bold rounded-lg disabled:opacity-30 disabled:cursor-not-allowed text-white transition-colors whitespace-nowrap ${
                            devBusy
                              ? "bg-amber-700 hover:bg-amber-600 active:bg-amber-800"
                              : "bg-blue-700 hover:bg-blue-600 active:bg-blue-800"
                          }`}
                        >
                          {isSending ? "…" : devBusy ? "⚠ Send" : "Send"}
                        </button>
                        {result && (
                          <span className={`text-[9px] max-w-[100px] truncate text-right font-mono ${
                            result.ok ? "text-emerald-400" : "text-red-400"
                          }`}>
                            {result.ok ? "✓ " : "✗ "}{result.msg}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Device status chips */}
          {connectionId && devices.length > 0 && (
            <div>
              <label className="block text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-2">
                Trạng thái devices
              </label>
              <div className="flex flex-wrap gap-1.5">
                {devices.map((d) => {
                  const isUsed = Object.values(assignments).includes(d.deviceId);
                  return (
                    <div
                      key={d.deviceId}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] transition-all ${
                        DEV_STATUS_CLS[d.status] ?? DEV_STATUS_CLS.idle
                      } ${isUsed ? "ring-1 ring-blue-500/40 ring-offset-1 ring-offset-gray-950" : ""}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DEV_DOT_CLS[d.status] ?? "bg-gray-500"}`} />
                      <span className="font-semibold">{d.name || d.deviceId.slice(0, 10)}</span>
                      {isUsed && <span className="text-blue-400 text-[8px]">●</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="shrink-0 border-t border-gray-800 px-6 py-4 flex items-center justify-between bg-gray-900/30 rounded-b-2xl">
          <div className="text-[11px] text-gray-600">
            {assignedCount === 0
              ? "Chưa gán device cho KHU nào"
              : `${assignedCount} / ${DEPTS.length} KHU đã gán`}
            {allOk && <span className="ml-2 text-emerald-400 font-semibold">✓ Đã gửi thành công</span>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-xl transition-colors"
            >
              Đóng
            </button>
            <button
              onClick={handleSendAll}
              disabled={assignedCount === 0 || sendingAll || sendingRow !== null}
              className="px-5 py-2 text-xs font-bold bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl transition-colors"
            >
              {sendingAll ? "Đang gửi…" : `Gửi tất cả (${assignedCount})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
