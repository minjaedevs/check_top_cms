/**
 * app-ws.ts
 * Handles WebSocket connections from check_top-app at /hubs/mobile-check
 *
 * Protocol: SignalR JSON v1
 * App sends TWO formats:
 *   Non-standard: {"event":"register_pool","target":"register_pool","deviceId":"PC","payload":{...}}
 *   Standard:     {"type":1,"target":"SubmitMobileResult","arguments":[...]}
 *   Ping:         {"type":6}
 *
 * All event payloads from app use camelCase field names:
 *   deviceId, poolId, sessionId, batchId, currentStep, requestId…
 */

import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { store } from "../store";
import {
  HANDSHAKE_RESPONSE,
  parseFrames,
  pingFrame,
  isHandshake,
  isPing,
  resolveEventName,
  resolvePayload,
} from "../protocol";
import type {
  Pool,
  Device,
  Session,
  RegisterPoolPayload,
  DeviceStatusPayload,
  JobStartPayload,
  StepChangePayload,
  SubmitMobileResultPayload,
  JobFailedPayload,
  JobSuccessPayload,
  BatchDeviceErrorPayload,
  DeviceFailRecoveryStartPayload,
  KhuData,
  KhuItem,
  QueryEligibleDevicePayload,
  EligibleDeviceResponsePayload,
  ForceReassignDevicePayload,
} from "../types";

export const { upgradeWebSocket, websocket } = createBunWebSocket();

let _connCounter = 0;
function nextId(): string {
  return `conn_${Date.now()}_${++_connCounter}`;
}

const PING_INTERVAL_MS = 15_000;
const DEVICE_WATCHDOG_MS = 3 * 60 * 1000; // 3 minutes
const DEVICE_POLL_INTERVAL_MS = 30_000;   // 30s — proactive device-status poll

// TH2a: per-connection retry state — requestId → retryCount
const retryMap = new Map<string, Map<string, number>>();

// TH2b Option2: safety watchdog per device — server acts if app never sends BatchDeviceError
// key = `${cid}:${deviceId}`, value = setTimeout handle
const RECOVERY_WATCHDOG_MS = 60_000; // 60s — app has 30s window + time to send event
const recoveryMap = new Map<string, ReturnType<typeof setTimeout>>();

function recoveryKey(cid: string, deviceId: string): string {
  return `${cid}:${deviceId}`;
}

function clearRecoveryWatchdog(cid: string, deviceId: string): void {
  const key = recoveryKey(cid, deviceId);
  const t = recoveryMap.get(key);
  if (t != null) { clearTimeout(t); recoveryMap.delete(key); }
}

function clearAllRecoveryForCid(cid: string): void {
  for (const [key, t] of recoveryMap) {
    if (key.startsWith(`${cid}:`)) { clearTimeout(t); recoveryMap.delete(key); }
  }
}

// ── TH2b: QueryEligibleDevice response collector ──────────────────────────────
// Server broadcasts QueryEligibleDevice to all other clients, collects responses
// within a 3s window, then routes keywords to the best eligible client.

const QUERY_TIMEOUT_MS = 3_000;

interface PendingQuery {
  cid:             string;         // failing client's connectionId
  ws:              WSContext;      // failing client's WebSocket
  deviceId:        string;         // failed device serial
  sessionId:       string | null;
  batchId:         string | null;
  currentDeptId:   string;         // current running department
  remainingItems:  KhuItem[];      // partial remaining of current khu
  allKhus:         KhuData[];      // full khu data for all khus (cross-PC)
  expectedCount:   number;         // number of other clients queried
  responses:       Array<{ connectionId: string; eligible: boolean; deviceId?: string }>;
  timer:           ReturnType<typeof setTimeout>;
}

const pendingQueries = new Map<string, PendingQuery>();

function buildCheckKeywordsForKhus(
  allKhus: KhuData[],
  targetDeviceId: string,
  sessionId: string
): string {
  const allItems: KhuItem[] = allKhus.flatMap((k) => k.items);
  return (
    JSON.stringify({
      type: 1,
      target: "CheckKeywords",
      sessionId,
      arguments: [allItems, { deviceId: targetDeviceId, targetDeviceId, sessionId }],
    }) + "\u001e"
  );
}

function processQueryResult(q: PendingQuery): void {
  // TH A: any eligible client found
  const eligible = q.responses.find((r) => r.eligible);
  if (eligible && q.allKhus.length > 0) {
    const otherSession = store.sessions.get(eligible.connectionId);
    const otherWs = otherSession?.ws as unknown as WSContext | undefined;
    if (otherWs) {
      // Pick the device they nominated, or first non-offline device in their pool
      const otherPool = store.pools.get(eligible.connectionId);
      const targetDevice =
        eligible.deviceId ||
        [...(otherPool?.devices.values() ?? [])].find((d) => d.status !== "offline")?.deviceId ||
        "";
      const sessionId = `SESS-TH2B-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const frame = buildCheckKeywordsForKhus(q.allKhus, targetDevice, sessionId);
      try { otherWs.send(frame); } catch { /* ignore */ }
      store.pushLog({
        ts: Date.now(), connectionId: eligible.connectionId, deviceId: targetDevice || "-",
        jobId: sessionId, batchId: null,
        step: "th2b_cross_pool_eligible", status: "running",
        detail: `TH2b: ${q.allKhus.length} khu(s) from failed device=${q.deviceId} (eligible via DK)`,
      });
      store.pushLog({
        ts: Date.now(), connectionId: q.cid, deviceId: q.deviceId,
        jobId: q.sessionId, batchId: q.batchId,
        step: "th2b_routed_cross_pool", status: "running",
        detail: `Routed → cid=${eligible.connectionId} device=${targetDevice || "-"}`,
      });
      console.log(`[TH2b] QueryResult TH-A: CheckKeywords → cid=${eligible.connectionId} device=${targetDevice}`);
      return;
    }
  }

  // TH B: no eligible — check failing client's pool first
  const pool = store.pools.get(q.cid);
  const otherDevices = pool
    ? [...pool.devices.values()].filter((d) => d.deviceId !== q.deviceId && d.status !== "offline")
    : [];

  if (otherDevices.length > 0) {
    // TH B1: same pool still has devices → ForceReassignDevice (partial current khu only)
    const forceFrame = JSON.stringify({
      event: "ForceReassignDevice",
      target: "ForceReassignDevice",
      payload: {
        queryId: `force_${Date.now()}`,
        originalDeviceId: q.deviceId,
        sessionId: q.sessionId,
        batchId: q.batchId,
        departmentId: q.currentDeptId,
        departmentName: q.remainingItems[0]?.departmentName ?? "",
        remainingItems: q.remainingItems,
      } satisfies ForceReassignDevicePayload,
    }) + "\u001e";
    try { q.ws.send(forceFrame); } catch { /* ignore */ }
    store.pushLog({
      ts: Date.now(), connectionId: q.cid, deviceId: q.deviceId,
      jobId: q.sessionId, batchId: q.batchId,
      step: "th2b_force_reassign", status: "running",
      detail: `ForceReassignDevice → same pool (remainingItems=${q.remainingItems.length})`,
    });
    console.log(`[TH2b] QueryResult TH-B1: ForceReassignDevice → cid=${q.cid}`);
    return;
  }

  // TH B2: failing client has 0 devices → any other client with devices (full khus)
  if (q.allKhus.length > 0) {
    for (const [otherCid, otherPool] of store.pools) {
      if (otherCid === q.cid) continue;
      const anyDevice = [...otherPool.devices.values()].find((d) => d.status !== "offline");
      if (!anyDevice) continue;
      const otherSession = store.sessions.get(otherCid);
      const otherWs2 = otherSession?.ws as unknown as WSContext | undefined;
      if (!otherWs2) continue;
      const sessionId = `SESS-TH2B-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const frame = buildCheckKeywordsForKhus(q.allKhus, anyDevice.deviceId, sessionId);
      try { otherWs2.send(frame); } catch { /* ignore */ }
      store.pushLog({
        ts: Date.now(), connectionId: otherCid, deviceId: anyDevice.deviceId,
        jobId: sessionId, batchId: null,
        step: "th2b_cross_pool_force", status: "running",
        detail: `TH2b B2: full khus from ${q.deviceId} (cid=${q.cid} had 0 devices)`,
      });
      store.pushLog({
        ts: Date.now(), connectionId: q.cid, deviceId: q.deviceId,
        jobId: q.sessionId, batchId: q.batchId,
        step: "th2b_routed_cross_pool_force", status: "running",
        detail: `B2: routed all khus → cid=${otherCid} device=${anyDevice.deviceId}`,
      });
      console.log(`[TH2b] QueryResult TH-B2: CheckKeywords(all khus) → cid=${otherCid} device=${anyDevice.deviceId}`);
      return;
    }
  }

  // Priority 3: no device anywhere
  store.broadcastDash({
    type: "step_log",
    data: {
      ts: Date.now(), connectionId: q.cid, deviceId: q.deviceId,
      jobId: q.sessionId, batchId: q.batchId,
      step: "no_device_globally", status: "failed",
      detail: `ALERT — no device globally for TH2b. session=${q.sessionId ?? "-"}`,
    },
  });
  console.warn(`[TH2b] QueryResult: no device anywhere cid=${q.cid} device=${q.deviceId}`);
}

// ── TH2b device takeover map ──────────────────────────────────────────────────
// When device B takes over device A's job, subsequent events (step_change,
// SubmitMobileResult, job_success/failed) still arrive with deviceId=A.
// This map redirects them to device B so FE shows logs under the correct column.
// key = `${originalCid}:${originalDeviceId}`
const takeoverMap = new Map<string, { newCid: string; newDeviceId: string }>();

function setTakeover(
  origCid: string, origDeviceId: string,
  newCid: string, newDeviceId: string
): void {
  takeoverMap.set(`${origCid}:${origDeviceId}`, { newCid, newDeviceId });
  console.log(`[takeover] ${origDeviceId} → ${newDeviceId} (cid ${origCid} → ${newCid})`);
}

function resolveTakeover(
  cid: string, deviceId: string
): { cid: string; deviceId: string } {
  const override = takeoverMap.get(`${cid}:${deviceId}`);
  return override ? { cid: override.newCid, deviceId: override.newDeviceId } : { cid, deviceId };
}

function clearTakeoverForCid(cid: string): void {
  for (const [key, val] of takeoverMap) {
    // Remove entries where cid is the ORIGINAL connection (key prefix)
    // OR where cid is the REPLACEMENT connection (val.newCid).
    // Without the second clause, a disconnecting replacement leaves stale
    // routing entries that keep pointing events at a dead WS connection.
    if (key.startsWith(`${cid}:`) || val.newCid === cid) {
      takeoverMap.delete(key);
    }
  }
}

/**
 * Returns true if the given device is currently serving as a takeover replacement
 * for at least one other original device.
 * Used to prevent premature idle when a device concurrently runs multiple sessions
 * (e.g. POCO running its own KHU C session AND borrowed KHU A session after Galaxy pulled).
 */
function isDeviceStillTakeover(cid: string, deviceId: string): boolean {
  for (const v of takeoverMap.values()) {
    if (v.newCid === cid && v.newDeviceId === deviceId) return true;
  }
  return false;
}

// ── Server-initiated device-status poll ───────────────────────────────────────
/**
 * Ask the Python client to immediately report the current status of every
 * connected device.  The client responds with one `device_status` event per
 * device, which flows through the normal `onDeviceStatus` handler → store →
 * FE broadcast.  This keeps FE in sync even when no jobs are running and no
 * natural events are flowing (e.g. after BE restart / client reconnect).
 */
function sendDeviceStatusPoll(ws: WSContext): void {
  const frame = JSON.stringify({
    event:   "poll_device_status",
    target:  "poll_device_status",
    payload: { requestedAt: Date.now() },
  }) + "\u001e";
  try { ws.send(frame); } catch { /* ignore */ }
}

// ── Device watchdog — fires if no step_change for 3 min while processing ──────
const deviceWatchMap = new Map<string, ReturnType<typeof setTimeout>>();

function watchKey(cid: string, deviceId: string): string {
  return `${cid}:${deviceId}`;
}

function resetDeviceWatchdog(cid: string, deviceId: string): void {
  const key = watchKey(cid, deviceId);
  const t = deviceWatchMap.get(key);
  if (t != null) clearTimeout(t);
  deviceWatchMap.set(
    key,
    setTimeout(() => {
      deviceWatchMap.delete(key);
      fireDeviceTimeout(cid, deviceId);
    }, DEVICE_WATCHDOG_MS)
  );
}

function clearDeviceWatchdog(cid: string, deviceId: string): void {
  const key = watchKey(cid, deviceId);
  const t = deviceWatchMap.get(key);
  if (t != null) { clearTimeout(t); deviceWatchMap.delete(key); }
}

function clearAllWatchdogsForCid(cid: string): void {
  for (const [key, t] of deviceWatchMap) {
    if (key.startsWith(`${cid}:`)) { clearTimeout(t); deviceWatchMap.delete(key); }
  }
}

function fireDeviceTimeout(cid: string, deviceId: string): void {
  const device = store.getDevice(cid, deviceId);
  if (!device || device.status !== "processing") return; // already done/idle

  console.warn(`[watchdog] Device ${deviceId} timeout (3 min no step) cid=${cid}`);
  store.updateDeviceStatus(cid, deviceId, { status: "failed" });
  store.pushLog({
    ts: Date.now(), connectionId: cid, deviceId,
    jobId: device.jobId, batchId: device.batchId,
    step: "device_timeout", status: "failed",
    detail: "No step_change for 3 minutes",
  });

  const session = store.sessions.get(cid);
  const ws = session?.ws as unknown as import("hono/ws").WSContext | undefined;

  // Try same-pool idle device first
  const pool = store.pools.get(cid);
  const samePoolIdle = pool
    ? [...pool.devices.values()].find((d) => d.deviceId !== deviceId && d.status === "idle")
    : null;

  const fallback = samePoolIdle ?? store.findIdleDeviceExcept(cid)?.device ?? null;
  const fallbackCid = samePoolIdle ? cid : (store.findIdleDeviceExcept(cid)?.connectionId ?? null);

  if (fallback && fallbackCid) {
    const frame = JSON.stringify({
      event: "BatchReassignFallback",
      target: "BatchReassignFallback",
      payload: {
        originalDeviceId: deviceId,
        fallbackDeviceId: fallback.deviceId,
        fallbackConnectionId: fallbackCid,
        sessionId: device.jobId,
        batchId: device.batchId,
        reason: "device_timeout",
      },
    }) + "\u001e";
    // Route to the connection that OWNS the fallback device so the correct
    // Python client (the one managing that device) handles the reassignment.
    // Falls back to original WS only when the other session is unavailable.
    const otherWs = fallbackCid !== cid
      ? (store.sessions.get(fallbackCid)?.ws as unknown as import("hono/ws").WSContext | undefined)
      : undefined;
    const targetWs = otherWs ?? ws;
    if (!targetWs) return; // both sessions gone — nothing to send
    try { targetWs.send(frame); } catch { /* ignore */ }
    store.pushLog({
      ts: Date.now(), connectionId: cid, deviceId,
      jobId: device.jobId, batchId: device.batchId,
      step: "device_timeout_reassigned", status: "failed",
      detail: `Reassigned → ${fallback.deviceId}`,
    });
    // Mark original device offline — timed out, handed to replacement
    setTakeover(cid, deviceId, fallbackCid, fallback.deviceId);
    store.updateDeviceStatus(cid, deviceId, { status: "offline", jobId: null, batchId: null });
    // Mark replacement processing + push takeover log
    store.updateDeviceStatus(fallbackCid, fallback.deviceId, {
      status: "processing", jobId: device.jobId, batchId: device.batchId,
    });
    store.pushLog({
      ts: Date.now(), connectionId: fallbackCid, deviceId: fallback.deviceId,
      jobId: device.jobId, batchId: device.batchId,
      step: "takeover_reassigned", status: "running",
      detail: `Chạy thay ${device.name ?? deviceId}`,
    });
    console.log(`[watchdog] Reassigned ${deviceId} → ${fallback.deviceId} (cid=${fallbackCid})`);
  } else {
    store.broadcastDash({
      type: "step_log",
      data: {
        ts: Date.now(), connectionId: cid, deviceId,
        jobId: device.jobId, batchId: device.batchId,
        step: "device_timeout_no_replacement", status: "failed",
        detail: `ALERT — no idle device found. session=${device.jobId ?? "-"}`,
      },
    });
    console.warn(`[watchdog] No replacement for ${deviceId} cid=${cid}`);
  }
}

export function appWsHandlers() {
  return upgradeWebSocket((_c) => {
    let connectionId = "";
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let handshakeDone = false;

    return {
      onOpen(_evt, ws) {
        connectionId = nextId();
        console.log(`[app-ws] connected  cid=${connectionId}`);

        pingTimer = setInterval(() => {
          try { ws.send(pingFrame()); } catch { /* ignore */ }
        }, PING_INTERVAL_MS);

        // Proactively poll device status every 30 s so FE stays in sync
        // even when no jobs are running (client may miss ADB transitions).
        pollTimer = setInterval(() => {
          sendDeviceStatusPoll(ws);
        }, DEVICE_POLL_INTERVAL_MS);
      },

      onMessage(evt, ws) {
        const raw = typeof evt.data === "string" ? evt.data : "";
        if (!raw) return;

        store.touchPool(connectionId);

        for (const msg of parseFrames(raw)) {
          const m = msg as Record<string, unknown>;

          if (!handshakeDone && isHandshake(m)) {
            ws.send(HANDSHAKE_RESPONSE);
            handshakeDone = true;
            console.log(`[app-ws] handshake ok cid=${connectionId}`);
            continue;
          }

          if (isPing(m)) continue;

          const event = resolveEventName(m);
          if (!event) continue;

          const payload = resolvePayload(m) as Record<string, unknown>;
          // top-level msg.deviceId = PC node ID (used only for register_pool)
          const nodeDeviceId = String(m.deviceId ?? "");

          handleEvent(connectionId, ws, event, payload, nodeDeviceId);
        }
      },

      onClose() {
        console.log(`[app-ws] disconnected cid=${connectionId}`);
        if (pingTimer) clearInterval(pingTimer);
        if (pollTimer) clearInterval(pollTimer);
        retryMap.delete(connectionId);
        clearAllWatchdogsForCid(connectionId);
        clearAllRecoveryForCid(connectionId);
        clearTakeoverForCid(connectionId);
        store.removePool(connectionId);
      },

      onError(err) {
        console.error(`[app-ws] error cid=${connectionId}`, err);
      },
    };
  });
}

// ─── Event dispatcher ─────────────────────────────────────────────────────────

function handleEvent(
  cid: string,
  ws: WSContext,
  event: string,
  payload: Record<string, unknown>,
  nodeDeviceId: string
): void {
  console.log(`[app-ws] event=${event} cid=${cid}`);

  switch (event) {
    case "register_pool":
    case "on_register_pool":  // alias used by some client builds
      return onRegisterPool(cid, ws, payload as unknown as RegisterPoolPayload, nodeDeviceId);
    case "device_status":
      return onDeviceStatus(cid, payload as unknown as DeviceStatusPayload);
    case "job_start":
      return onJobStart(cid, payload as unknown as JobStartPayload);
    case "step_change":
      return onStepChange(cid, payload as unknown as StepChangePayload);
    case "SubmitMobileResult":
      return onSubmitResult(cid, ws, payload as unknown as SubmitMobileResultPayload);
    case "job_success":
      return onJobSuccess(cid, payload as unknown as JobSuccessPayload);
    case "job_failed":
      return onJobFailed(cid, payload as unknown as JobFailedPayload);
    case "recovering_done":
      return onRecoveringDone(cid, payload as { deviceId: string });
    case "BatchDeviceError":
      return onBatchDeviceError(cid, ws, payload as unknown as BatchDeviceErrorPayload);
    case "EligibleDeviceResponse":
      return onEligibleDeviceResponse(cid, payload as unknown as EligibleDeviceResponsePayload);
    case "device_fail_recovery_start":
      return onDeviceFailRecoveryStart(cid, ws, payload as unknown as DeviceFailRecoveryStartPayload);
    case "device_fail_recovery_cancel": {
      const p = payload as { deviceId: string };
      clearRecoveryWatchdog(cid, p.deviceId);
      console.log(`[app-ws] device_fail_recovery_cancel: watchdog cleared for ${p.deviceId} cid=${cid}`);
      return;
    }
    default:
      console.log(`[app-ws] unknown event="${event}" cid=${cid}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse departmentId and departmentName from requestId pipe-delimited format:
 *   keyword|country|proxy|uuid|departmentId|departmentName
 */
function parseReqIdDept(requestId: string | null | undefined): { deptId: string | null; deptName: string | null } {
  if (!requestId) return { deptId: null, deptName: null };
  const parts = requestId.split("|");
  const deptId   = parts[4] || null;
  const rawName  = parts[5] ?? "";
  const deptName = rawName
    ? (() => { try { return decodeURIComponent(rawName); } catch { return rawName; } })()
    : null;
  return { deptId, deptName };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * register_pool
 * App sends: { event, target, deviceId:"PC-NODE", payload:{ poolId, devices:[{deviceId, name, model}] } }
 * nodeDeviceId = top-level msg.deviceId (PC node identifier)
 */
function onRegisterPool(
  cid: string,
  ws: WSContext,
  p: RegisterPoolPayload,
  nodeDeviceId: string
): void {
  const now = Date.now();

  const devices = new Map<string, Device>();
  for (const d of p.devices ?? []) {
    if (!d.deviceId) continue;
    devices.set(d.deviceId, {
      deviceId: d.deviceId,
      model: d.model ?? "Unknown",
      name: d.name ?? d.deviceId,
      status: "idle",
      jobId: null,
      batchId: null,
      retryCount: 0,
      lastUpdated: now,
    });
  }

  // ── Re-register: connection pool already exists → upsert devices ─────────────
  const existing = store.pools.get(cid);
  if (existing) {
    const incomingIds = new Set(devices.keys());

    // 1. Upsert incoming devices
    for (const [id, fresh] of devices) {
      const cur = existing.devices.get(id);
      if (cur) {
        // Update static info; restore offline/done → idle (device plugged back in)
        const restoredStatus: Device["status"] =
          (cur.status === "offline" || cur.status === "done") ? "idle" : cur.status;
        const upsertPatch: Partial<Device> = { model: fresh.model, name: fresh.name, status: restoredStatus };
        // Clear stale job state when device comes back online via register_pool
        if (restoredStatus === "idle" && (cur.status === "offline" || cur.status === "done")) {
          upsertPatch.jobId      = null;
          upsertPatch.batchId    = null;
          upsertPatch.retryCount = 0;
        }
        store.updateDeviceStatus(cid, id, upsertPatch);
      } else {
        // Brand-new device — add to pool map then broadcast via updateDeviceStatus
        existing.devices.set(id, fresh);
        store.updateDeviceStatus(cid, id, {}); // reads from map, broadcasts device_update
      }
    }

    // 2. Idle devices missing from the new list → mark offline (don't interrupt active jobs)
    for (const [id] of existing.devices) {
      if (!incomingIds.has(id)) {
        const dev = existing.devices.get(id)!;
        if (dev.status === "idle") {
          store.updateDeviceStatus(cid, id, { status: "offline" });
        }
      }
    }

    // 3. Update pool meta + broadcast full pool snapshot so FE stays in sync
    existing.poolId   = p.poolId  || existing.poolId;
    existing.nodeId   = nodeDeviceId || existing.nodeId;
    existing.lastSeen = now;
    store.broadcastPool(cid);

    console.log(`[app-ws] pool re-registered cid=${cid} pool=${p.poolId} devices=${existing.devices.size}`);
    // Immediately request a fresh device-status report so FE reflects reality
    // (re-register often happens after a client restart; statuses may be stale).
    sendDeviceStatusPoll(ws);
    return;
  }

  retryMap.set(cid, new Map());

  const pool: Pool = {
    connectionId: cid,
    poolId: p.poolId ?? "unknown",
    nodeId: nodeDeviceId,
    secret: "",
    devices,
    connectedAt: now,
    lastSeen: now,
  };

  const session: Session = { connectionId: cid, ws: ws as unknown as WebSocket, pool };
  store.addPool(session);
  console.log(`[app-ws] pool registered cid=${cid} pool=${p.poolId} node=${nodeDeviceId} devices=${devices.size}`);
  // Immediately request a fresh device-status report so FE gets accurate idle/processing
  // state right after the pool is registered (not just the default "idle" from the payload).
  sendDeviceStatusPoll(ws);
}

/**
 * device_status
 * App payload: { deviceId, status:"online"/"idle"/"offline"/"busy" }
 */
function onDeviceStatus(cid: string, p: DeviceStatusPayload): void {
  const statusMap: Record<string, Device["status"]> = {
    online:     "idle",      // device visible/connected → ready
    idle:       "idle",
    offline:    "offline",   // device unplugged — stays in pool, NOT removed
    busy:       "processing",
    processing: "processing",
    failed:     "failed",
    recovering: "recovering",
    done:       "done",
  };
  const newStatus = statusMap[p.status?.toLowerCase()] ?? "idle";

  // Guard: pool must exist (device_status may race with register_pool)
  if (!store.pools.has(cid)) {
    console.warn(`[app-ws] device_status for unknown pool cid=${cid} deviceId=${p.deviceId} — ignored`);
    return;
  }

  const cur = store.getDevice(cid, p.deviceId);

  // Guard: once a device is marked offline (physically unplugged or TH2b takeover),
  // block spurious "idle" heartbeat flashes (device_status: idle) that would flip
  // the column back to IDLE while the device is actually disconnected.
  // EXCEPTION: "online" is the explicit re-plug signal from the app — allow it through
  // so the device column is restored to IDLE when the user re-plugs the cable.
  if (cur?.status === "offline" && newStatus === "idle" && p.status?.toLowerCase() !== "online") {
    console.log(`[device_status] cid=${cid} device=${p.deviceId} — skipping idle (device offline; restore via register_pool or explicit 'online' event)`);
    return;
  }

  // Skip no-op: status unchanged → no store write, no FE broadcast
  // (prevents 30s poll from triggering unnecessary re-renders when devices are idle)
  if (cur?.status === newStatus) return;

  store.updateDeviceStatus(cid, p.deviceId, { status: newStatus });
  console.log(`[device_status] cid=${cid} device=${p.deviceId} ${cur?.status ?? "?"} → ${newStatus}`);
}

/**
 * job_start
 * App payload: { deviceId, sessionId, batchId, action, keywordsCount }
 */
function onJobStart(cid: string, p: JobStartPayload): void {
  const jobId   = p.sessionId ?? null;
  // App nests batchId inside metadata.batchId — fall back to top-level p.batchId for compatibility
  const batchId = p.batchId ?? (p.metadata?.batchId ?? null);
  const deptId  = p.metadata?.departmentId ?? null;

  store.updateDeviceStatus(cid, p.deviceId, { status: "processing", jobId, batchId });
  resetDeviceWatchdog(cid, p.deviceId); // start 3-min watchdog

  const detail = [
    p.action ? `action=${p.action}` : null,
    (p.keywordsCount ?? p.metadata?.keywordsCount) ? `count=${p.keywordsCount ?? p.metadata?.keywordsCount}` : null,
    deptId ? `dept=${deptId}` : null,
  ].filter(Boolean).join(" ") || undefined;

  console.log(`[job_start] cid=${cid} device=${p.deviceId} session=${jobId ?? "-"} batch=${batchId ?? "-"} dept=${deptId ?? "-"} action=${p.action ?? "-"} count=${p.keywordsCount ?? p.metadata?.keywordsCount ?? "-"}`);

  store.pushLog({
    ts: Date.now(), connectionId: cid, deviceId: p.deviceId,
    jobId, batchId, step: "job_start", status: "running", detail,
  });
}

/**
 * step_change
 * App payload: { deviceId, currentStep, keyword, requestId, batchId, sessionId }
 * NOTE: app uses "currentStep" not "step"
 */
function onStepChange(cid: string, p: StepChangePayload): void {
  // Remap to replacement device if TH2b takeover is active
  const resolved = resolveTakeover(cid, p.deviceId);
  resetDeviceWatchdog(resolved.cid, resolved.deviceId); // heartbeat for the actual running device
  const { deptId } = parseReqIdDept(p.requestId);
  const detailParts = [
    p.keyword ? `kw="${p.keyword}"` : null,
    deptId    ? `dept=${deptId}`    : null,
  ].filter(Boolean);
  store.pushLog({
    ts: Date.now(),
    connectionId: resolved.cid,
    deviceId: resolved.deviceId,
    jobId: p.requestId ?? p.sessionId ?? null,
    batchId: p.batchId ?? null,
    step: p.currentStep,
    status: "running",
    detail: detailParts.length ? detailParts.join(" ") : undefined,
  });
}

/**
 * SubmitMobileResult (SignalR type:1 invocation)
 * App payload: { requestId, deviceId, poolId, items:[{top,position,rank,title,url,domain}], publicIp, sourceName }
 *
 * requestId format (production): keyword|country|proxy|uuid|departmentId|departmentName
 *   parts[0] = URL-encoded keyword — we decode this to get the actual keyword string.
 *
 * TH1:  items.length > 0 → keyword success
 * TH2a: items.length === 0 → keyword failed → retry ≤ 2 times, then ALERT
 */
function onSubmitResult(
  cid: string,
  ws: WSContext,
  p: SubmitMobileResultPayload
): void {
  // Remap to replacement device if TH2b takeover is active.
  // retryMap and ws still use original cid (the WS connection that sent the event).
  const resolved = resolveTakeover(cid, p.deviceId);

  const isSuccess = Array.isArray(p.items) && p.items.length > 0;
  const topDomain = isSuccess ? (p.items[0]?.domain ?? null) : null;

  // Extract keyword from requestId format: encodeURI(keyword)|country|proxy|uuid|...
  const keyword = (() => {
    try {
      const first = (p.requestId ?? "").split("|")[0];
      return first ? decodeURIComponent(first) : (p.requestId ?? "unknown");
    } catch {
      return p.requestId ?? "unknown";
    }
  })();

  // Map items[] to SerpItem[]
  const serp = (p.items ?? []).map((it, i) => ({
    title: it.title ?? "",
    link: it.url ?? "",
    position: it.position ?? it.rank ?? it.top ?? i + 1,
    domain: it.domain,
  }));

  const topPosition = isSuccess
    ? (p.items[0]?.top ?? p.items[0]?.position ?? p.items[0]?.rank ?? null)
    : null;

  store.pushResult({
    ts: Date.now(),
    connectionId: resolved.cid,
    deviceId: resolved.deviceId,
    jobId: p.requestId ?? null,
    batchId: p.sessionId ?? null,   // sessionId echoed back so FE can match result → session by batchId
    keyword,
    status: isSuccess ? "success" : "failed",
    topDomain,
    topPosition,
    serp,
  });

  if (isSuccess) {
    // Reset device retryCount if it was in a retry cycle (retryMap keyed by original cid)
    const hadRetry = retryMap.get(cid)?.has(p.requestId) ?? false;
    retryMap.get(cid)?.delete(p.requestId);
    if (hadRetry) store.updateDeviceStatus(resolved.cid, resolved.deviceId, { retryCount: 0 });

    console.log(`[submit_result] ✓ cid=${cid} device=${resolved.deviceId} session=${p.sessionId ?? "-"} kw="${keyword}" top=${topDomain ?? "-"} items=${serp.length} ip=${p.publicIp ?? "-"}`);

    store.pushLog({
      ts: Date.now(), connectionId: resolved.cid, deviceId: resolved.deviceId,
      jobId: p.requestId ?? null, batchId: null,
      step: "submit_result", status: "success",
      detail: `kw="${keyword}" top=${topDomain ?? "-"} items=${serp.length}`,
    });
    return;
  }

  console.log(`[submit_result] ✗ cid=${cid} device=${resolved.deviceId} session=${p.sessionId ?? "-"} kw="${keyword}" items=0 → TH2a retry`);

  // ── TH2a: keyword failed ──────────────────────────────────────────────────
  const cRetries = retryMap.get(cid) ?? new Map<string, number>();
  retryMap.set(cid, cRetries);
  const current = cRetries.get(p.requestId) ?? 0;

  store.pushLog({
    ts: Date.now(), connectionId: resolved.cid, deviceId: resolved.deviceId,
    jobId: p.requestId ?? null, batchId: null,
    step: "submit_failed", status: "failed",
    detail: `kw="${keyword}" retry=${current}/2`,
  });

  if (current < 2) {
    const nextRetry = current + 1;
    cRetries.set(p.requestId, nextRetry);
    store.incJobRetry();
    // Update retryCount on the actual running device
    store.updateDeviceStatus(resolved.cid, resolved.deviceId, { retryCount: nextRetry });

    // S→C: RetryBatch — sent via original WS connection (app is still on original cid)
    const frame = JSON.stringify({
      event: "RetryBatch",
      target: "RetryBatch",
      payload: {
        requestId: p.requestId,
        deviceId: p.deviceId,
        retryCount: nextRetry,
        failedKeywords: [],
      },
    }) + "\u001e";
    try { ws.send(frame); } catch { /* ignore */ }
    console.log(`[app-ws] TH2a RetryBatch reqId=${p.requestId} retry=${nextRetry}`);
  } else {
    // Max retries exceeded → alert only (do NOT incJobFailed — job-level stats
    // are handled exclusively by onJobSuccess / onJobFailed to avoid double-count)
    cRetries.delete(p.requestId);
    store.updateDeviceStatus(resolved.cid, resolved.deviceId, { retryCount: 0 });
    store.broadcastDash({
      type: "step_log",
      data: {
        ts: Date.now(), connectionId: resolved.cid, deviceId: resolved.deviceId,
        jobId: p.requestId ?? null, batchId: null,
        step: "max_retry_exceeded", status: "failed",
        detail: `ALERT Telegram — 2 retries failed. reqId=${p.requestId} device=${resolved.deviceId}`,
      },
    });
    console.warn(`[app-ws] TH2a max retries exceeded reqId=${p.requestId} cid=${cid}`);
  }
}

/**
 * job_success
 * App payload: { deviceId, sessionId, totalKeywords, videoPath }
 */
function onJobSuccess(cid: string, p: JobSuccessPayload): void {
  const resolved = resolveTakeover(cid, p.deviceId);
  // Clear takeover mapping for this original→replacement pair — job is done.
  // NOTE: if resolved.deviceId is the REPLACEMENT, this delete is a no-op
  // (the entry key is the ORIGINAL device); the entry is removed by the
  // job that owns that original-device key.
  takeoverMap.delete(`${cid}:${p.deviceId}`);
  clearDeviceWatchdog(resolved.cid, resolved.deviceId);

  // Guard: resolved device may still be serving as a replacement for ANOTHER
  // original device's session (e.g. POCO running both its own KHU C session
  // and a borrowed KHU A session after Galaxy was pulled).
  // Only idle the device once ALL sessions routed to it have completed.
  if (isDeviceStillTakeover(resolved.cid, resolved.deviceId)) {
    console.log(`[job_success] device=${resolved.deviceId} still serving as takeover — deferring idle cid=${resolved.cid}`);
  } else {
    store.updateDeviceStatus(resolved.cid, resolved.deviceId, { status: "idle", jobId: null, batchId: null });
  }

  store.incJobSuccess();
  console.log(`[job_success] ✓ cid=${cid} device=${resolved.deviceId} session=${p.sessionId ?? "-"} batch=${p.batchId ?? "-"} total=${p.totalKeywords ?? "-"}`);
  store.pushLog({
    ts: Date.now(), connectionId: resolved.cid, deviceId: resolved.deviceId,
    jobId: p.sessionId ?? null, batchId: p.batchId ?? null,
    step: "job_success", status: "success",
    detail: p.totalKeywords ? `total=${p.totalKeywords}` : undefined,
  });
}

/**
 * job_failed
 * App payload: { deviceId, sessionId, reason:"keyword_failed"|"device_not_found"|"missing_full_video"|"hls_failed" }
 *
 * NOTE: keyword retry (TH2a) is handled in onSubmitResult.
 * job_failed here = whole batch closed with failure.
 *
 * Device status → "idle" (NOT "failed") because job_failed means the BATCH failed,
 * not the device hardware. The device is still operational and ready for new work.
 * Physical device failures are reported separately via device_status:"offline" / watchdog.
 */
function onJobFailed(cid: string, p: JobFailedPayload): void {
  const resolved = resolveTakeover(cid, p.deviceId);
  // Clear takeover mapping for this original→replacement pair — job is done.
  takeoverMap.delete(`${cid}:${p.deviceId}`);
  clearDeviceWatchdog(resolved.cid, resolved.deviceId);

  // Guard: same as onJobSuccess — only idle when no other session is still
  // routing through this device as a takeover replacement.
  if (isDeviceStillTakeover(resolved.cid, resolved.deviceId)) {
    console.log(`[job_failed] device=${resolved.deviceId} still serving as takeover — deferring idle cid=${resolved.cid}`);
    store.updateDeviceStatus(resolved.cid, resolved.deviceId, { retryCount: 0 });
  } else {
    store.updateDeviceStatus(resolved.cid, resolved.deviceId, {
      status: "idle",
      jobId: null,
      batchId: null,
      retryCount: 0,
    });
  }

  store.incJobFailed();
  console.log(`[job_failed] ✗ cid=${cid} device=${resolved.deviceId} session=${p.sessionId ?? "-"} batch=${p.batchId ?? "-"} reason=${p.reason ?? "-"}`);
  store.pushLog({
    ts: Date.now(), connectionId: resolved.cid, deviceId: resolved.deviceId,
    jobId: p.sessionId ?? null, batchId: p.batchId ?? null,
    step: "job_failed", status: "failed", detail: p.reason,
  });
}

/**
 * recovering_done
 * App payload: { deviceId }
 */
function onRecoveringDone(cid: string, p: { deviceId: string }): void {
  clearDeviceWatchdog(cid, p.deviceId);
  store.updateDeviceStatus(cid, p.deviceId, {
    status: "idle", retryCount: 0, jobId: null, batchId: null,
  });
  store.pushLog({
    ts: Date.now(), connectionId: cid, deviceId: p.deviceId,
    jobId: null, batchId: null, step: "recovering_done", status: "success",
  });
}

/**
 * BatchDeviceError (TH2b — C→S)
 *
 * status=REASSIGNED:
 *   Client handled internally — server logs and updates device states.
 *   Also used after ForceReassignDevice when client picks a replacement.
 *
 * status=NO_ELIGIBLE_DEVICE:
 *   Client could not find an eligible device (DK1/2/3 all failed).
 *   Server:
 *     1. Mark original device offline.
 *     2. Broadcast QueryEligibleDevice to ALL other clients.
 *     3. Collect EligibleDeviceResponse (3s timeout).
 *     4a. TH-A: eligible found → CheckKeywords(allKhus) → that client (full khus, cross-PC).
 *     4b. TH-B1: none eligible, same pool still has devices → ForceReassignDevice(remainingItems).
 *     4c. TH-B2: same pool empty → any other pool → CheckKeywords(allKhus).
 *     4d. Nothing → alert.
 */
function onBatchDeviceError(
  cid: string,
  ws: WSContext,
  p: BatchDeviceErrorPayload
): void {
  // Cancel safety watchdog — app confirmed alive by sending BatchDeviceError
  clearRecoveryWatchdog(cid, p.deviceId);

  store.pushLog({
    ts: Date.now(), connectionId: cid, deviceId: p.deviceId,
    jobId: p.sessionId ?? null, batchId: p.batchId ?? null,
    step: "batch_device_error", status: "failed",
    detail: `status=${p.status}${p.deviceId_new ? ` new=${p.deviceId_new}` : ""}${p.currentDeptId ? ` dept=${p.currentDeptId}` : ""}`,
  });

  // ── REASSIGNED (internal or force-reassign result) ────────────────────────
  if (p.status === "REASSIGNED") {
    console.log(`[app-ws] TH2b REASSIGNED device=${p.deviceId} → ${p.deviceId_new ?? "-"} cid=${cid}`);
    const origDev = store.getDevice(cid, p.deviceId);
    store.updateDeviceStatus(cid, p.deviceId, { status: "offline", jobId: null, batchId: null });
    if (p.deviceId_new) {
      setTakeover(cid, p.deviceId, cid, p.deviceId_new);
      store.updateDeviceStatus(cid, p.deviceId_new, {
        status: "processing", jobId: p.sessionId ?? null, batchId: p.batchId ?? null,
      });
      store.pushLog({
        ts: Date.now(), connectionId: cid, deviceId: p.deviceId_new,
        jobId: p.sessionId ?? null, batchId: p.batchId ?? null,
        step: "takeover_reassigned", status: "running",
        detail: `Chạy thay ${origDev?.name ?? p.deviceId}`,
      });
    }
    return;
  }

  // ── NO_ELIGIBLE_DEVICE ────────────────────────────────────────────────────

  const remainingItems: KhuItem[] = p.remainingItems ?? [];
  const allKhus: KhuData[]        = p.allKhus ?? [];
  const currentDeptId              = p.currentDeptId ?? remainingItems[0]?.departmentId ?? "";

  // Mark original device offline immediately
  store.updateDeviceStatus(cid, p.deviceId, { status: "offline", jobId: null, batchId: null });
  store.pushLog({
    ts: Date.now(), connectionId: cid, deviceId: p.deviceId,
    jobId: p.sessionId ?? null, batchId: p.batchId ?? null,
    step: "th2b_no_eligible_device", status: "failed",
    detail: `Client found no eligible device. remainingItems=${remainingItems.length} khus=${allKhus.length} dept=${currentDeptId}`,
  });

  // Find all other connections to query
  const otherCids = [...store.sessions.keys()].filter((c) => c !== cid);

  if (otherCids.length === 0) {
    // No other clients → immediate fallback (same pool or drop)
    console.log(`[TH2b] NO_ELIGIBLE_DEVICE: no other clients — immediate fallback cid=${cid}`);
    processQueryResult({
      cid, ws, deviceId: p.deviceId,
      sessionId: p.sessionId ?? null, batchId: p.batchId ?? null,
      currentDeptId, remainingItems, allKhus,
      expectedCount: 0, responses: [],
      timer: setTimeout(() => {}, 0), // dummy timer (already processed)
    });
    return;
  }

  // Build queryId and broadcast to all other clients
  const queryId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const queryPayload: QueryEligibleDevicePayload = {
    queryId,
    departmentId: currentDeptId,
    remainingCount: remainingItems.length,
    sessionId: p.sessionId ?? undefined,
  };
  const queryFrame = JSON.stringify({
    event: "QueryEligibleDevice",
    target: "QueryEligibleDevice",
    payload: queryPayload,
  }) + "\u001e";

  let queried = 0;
  for (const otherCid of otherCids) {
    const otherSession = store.sessions.get(otherCid);
    const otherWs = otherSession?.ws as unknown as WSContext | undefined;
    if (!otherWs) continue;
    try { otherWs.send(queryFrame); queried++; } catch { /* ignore */ }
  }

  console.log(`[TH2b] QueryEligibleDevice queryId=${queryId} sent to ${queried} client(s)`);

  if (queried === 0) {
    // No reachable clients — immediate fallback
    processQueryResult({
      cid, ws, deviceId: p.deviceId,
      sessionId: p.sessionId ?? null, batchId: p.batchId ?? null,
      currentDeptId, remainingItems, allKhus,
      expectedCount: 0, responses: [],
      timer: setTimeout(() => {}, 0),
    });
    return;
  }

  const timer = setTimeout(() => {
    const q = pendingQueries.get(queryId);
    if (!q) return;
    pendingQueries.delete(queryId);
    console.log(`[TH2b] QueryEligibleDevice queryId=${queryId} timeout — processing ${q.responses.length}/${q.expectedCount} responses`);
    processQueryResult(q);
  }, QUERY_TIMEOUT_MS);

  pendingQueries.set(queryId, {
    cid, ws, deviceId: p.deviceId,
    sessionId: p.sessionId ?? null, batchId: p.batchId ?? null,
    currentDeptId, remainingItems, allKhus,
    expectedCount: queried,
    responses: [],
    timer,
  });
}

/**
 * EligibleDeviceResponse (C→S)
 * Client responds to server's QueryEligibleDevice after running DK1/2/3.
 */
function onEligibleDeviceResponse(
  cid: string,
  p: EligibleDeviceResponsePayload
): void {
  const q = pendingQueries.get(p.queryId);
  if (!q) {
    console.log(`[TH2b] EligibleDeviceResponse: unknown queryId=${p.queryId} cid=${cid} — ignoring`);
    return;
  }

  q.responses.push({ connectionId: cid, eligible: p.eligible, deviceId: p.deviceId });
  console.log(
    `[TH2b] EligibleDeviceResponse: cid=${cid} eligible=${p.eligible} device=${p.deviceId ?? "-"} ` +
    `(${q.responses.length}/${q.expectedCount})`
  );

  // Process immediately if we have an eligible response OR all clients have responded
  if (p.eligible || q.responses.length >= q.expectedCount) {
    clearTimeout(q.timer);
    pendingQueries.delete(p.queryId);
    processQueryResult(q);
  }
}

/**
 * device_fail_recovery_start (TH2b Option 2 — C→S)
 * App sends immediately when a mid-job device goes offline.
 * Server starts a 60s safety timeout; if BatchDeviceError never arrives
 * (app crash / silent hang), server fires the same fallback logic.
 */
function onDeviceFailRecoveryStart(
  cid: string,
  ws: WSContext,
  p: DeviceFailRecoveryStartPayload
): void {
  const deviceId = p.deviceId;
  if (!deviceId) {
    console.warn(`[app-ws] device_fail_recovery_start missing deviceId cid=${cid}`);
    return;
  }

  // Cancel any pre-existing safety timer for this device (re-plug scenario)
  clearRecoveryWatchdog(cid, deviceId);

  const windowMs = typeof p.windowMs === "number" ? p.windowMs : 30_000;
  // Give server-side safety timeout = app window + 30s buffer
  const safetyMs = windowMs + 30_000;

  console.log(
    `[app-ws] TH2b device_fail_recovery_start device=${deviceId} cid=${cid}` +
    ` — safety watchdog ${safetyMs / 1000}s`
  );

  store.pushLog({
    ts: Date.now(), connectionId: cid, deviceId,
    jobId: p.sessionId ?? null, batchId: p.batchId ?? null,
    step: "device_fail_recovery_start", status: "running",
    detail: `App handling internally. Safety timeout ${safetyMs / 1000}s`,
  });

  const t = setTimeout(() => {
    recoveryMap.delete(recoveryKey(cid, deviceId));
    fireRecoveryFallback(cid, ws, deviceId, p.sessionId ?? null, p.batchId ?? null);
  }, safetyMs);
  recoveryMap.set(recoveryKey(cid, deviceId), t);
}

/**
 * Fired when the 60s safety watchdog expires — app never sent BatchDeviceError.
 * Applies the same fallback logic as onBatchDeviceError's NO_ELIGIBLE_DEVICE branch.
 */
function fireRecoveryFallback(
  cid: string,
  ws: WSContext,
  deviceId: string,
  sessionId: string | null,
  batchId: string | null
): void {
  const device = store.getDevice(cid, deviceId);

  console.warn(
    `[app-ws] TH2b safety watchdog expired — device=${deviceId} cid=${cid} ` +
    `status=${device?.status ?? "unknown"}`
  );

  store.pushLog({
    ts: Date.now(), connectionId: cid, deviceId,
    jobId: sessionId, batchId,
    step: "recovery_watchdog_timeout", status: "failed",
    detail: "App did not send BatchDeviceError within safety window — server taking over",
  });

  // 1. Idle device in another connection
  const found = store.findIdleDeviceExcept(cid);
  if (found) {
    const otherSession = store.sessions.get(found.connectionId);
    const otherWs = otherSession?.ws as unknown as import("hono/ws").WSContext | undefined;
    const frame = JSON.stringify({
      event: "BatchReassignFallback",
      target: "BatchReassignFallback",
      payload: {
        originalDeviceId: deviceId,
        fallbackDeviceId: found.device.deviceId,
        fallbackConnectionId: found.connectionId,
        sessionId,
        batchId,
        reason: "recovery_watchdog",
      },
    }) + "\u001e";
    const target = otherWs ?? ws;
    try { target.send(frame); } catch { /* ignore */ }
    store.pushLog({
      ts: Date.now(), connectionId: cid, deviceId,
      jobId: sessionId, batchId,
      step: "recovery_watchdog_reassigned", status: "running",
      detail: `Fallback → ${found.device.deviceId} (cid=${found.connectionId})`,
    });
    // Mark original device offline
    const rwOrigDev1 = store.getDevice(cid, deviceId);
    setTakeover(cid, deviceId, found.connectionId, found.device.deviceId);
    store.updateDeviceStatus(cid, deviceId, { status: "offline", jobId: null, batchId: null });
    // Mark replacement processing + push takeover log
    store.updateDeviceStatus(found.connectionId, found.device.deviceId, {
      status: "processing", jobId: sessionId, batchId,
    });
    store.pushLog({
      ts: Date.now(), connectionId: found.connectionId, deviceId: found.device.deviceId,
      jobId: sessionId, batchId,
      step: "takeover_reassigned", status: "running",
      detail: `Chạy thay ${rwOrigDev1?.name ?? deviceId}`,
    });
    console.log(`[app-ws] TH2b recovery watchdog reassigned ${deviceId} → ${found.device.deviceId}`);
    return;
  }

  // 2. No other connection — first non-offline device in same pool (force)
  const pool = store.pools.get(cid);
  const anyActive = pool
    ? [...pool.devices.values()].find(
        (d) => d.deviceId !== deviceId && d.status !== "offline"
      )
    : null;

  if (anyActive) {
    const frame = JSON.stringify({
      event: "BatchReassignFallback",
      target: "BatchReassignFallback",
      payload: {
        originalDeviceId: deviceId,
        fallbackDeviceId: anyActive.deviceId,
        fallbackConnectionId: cid,
        sessionId,
        batchId,
        force: true,
        reason: "recovery_watchdog",
      },
    }) + "\u001e";
    try { ws.send(frame); } catch { /* ignore */ }
    store.pushLog({
      ts: Date.now(), connectionId: cid, deviceId,
      jobId: sessionId, batchId,
      step: "recovery_watchdog_force_fallback", status: "running",
      detail: `Force fallback → ${anyActive.deviceId} (same pool)`,
    });
    // Mark original device offline
    const rwOrigDev2 = store.getDevice(cid, deviceId);
    setTakeover(cid, deviceId, cid, anyActive.deviceId);
    store.updateDeviceStatus(cid, deviceId, { status: "offline", jobId: null, batchId: null });
    // Mark replacement processing + push takeover log
    store.updateDeviceStatus(cid, anyActive.deviceId, {
      status: "processing", jobId: sessionId, batchId,
    });
    store.pushLog({
      ts: Date.now(), connectionId: cid, deviceId: anyActive.deviceId,
      jobId: sessionId, batchId,
      step: "takeover_reassigned", status: "running",
      detail: `Chạy thay ${rwOrigDev2?.name ?? deviceId}`,
    });
    console.log(`[app-ws] TH2b recovery watchdog force-fallback → ${anyActive.deviceId} cid=${cid}`);
    return;
  }

  // 3. No device anywhere — alert FE
  store.broadcastDash({
    type: "step_log",
    data: {
      ts: Date.now(), connectionId: cid, deviceId,
      jobId: sessionId, batchId,
      step: "no_device_globally", status: "failed",
      detail: `ALERT — no active device globally after recovery timeout. session=${sessionId ?? "-"}`,
    },
  });
  console.warn(`[app-ws] TH2b recovery watchdog: no device globally cid=${cid}`);
}

// ─── Send to app (used by API routes) ────────────────────────────────────────

export function sendToApp(connectionId: string, frameStr: string): boolean {
  const session = store.sessions.get(connectionId);
  if (!session) return false;
  try {
    (session.ws as unknown as WSContext).send(frameStr);
    return true;
  } catch {
    return false;
  }
}
