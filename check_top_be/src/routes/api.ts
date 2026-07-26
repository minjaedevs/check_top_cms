/**
 * api.ts
 * REST endpoints for the dashboard UI
 *
 * GET  /api/state               → full snapshot
 * GET  /api/pools               → pool list with devices
 * POST /api/send-keywords       → push CheckKeywords to a specific device
 * POST /api/device-command      → send device_command to a device
 */

import { Hono } from "hono";
import { store } from "../store";
import { sendToApp } from "../handlers/app-ws";
import { RECORD_SEP } from "../protocol";
import type { SendKeywordsRequest, DeviceCommandRequest } from "../types";

const api = new Hono();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a requestId matching the real production format:
 *   {encodeURIComponent(keyword)}|{country}|{encodeURIComponent(proxy)}|{uuid}|{departmentId}|{encodeURIComponent(departmentName)}
 *
 * Example (from real data):
 *   "Jun88|1|171.236.84.199%3A57968%3Aajftm_itweb%3AIKIV066p|a6cdba90-...|b74f5303-...|KHU%20A"
 */
function buildRequestId(opts: {
  keyword: string;
  country: number;
  proxy: string;
  departmentId: string;
  departmentName: string;
}): string {
  const uuid = crypto.randomUUID();
  return [
    encodeURIComponent(opts.keyword),
    opts.country,
    encodeURIComponent(opts.proxy || ""),
    uuid,
    opts.departmentId || crypto.randomUUID(),
    encodeURIComponent(opts.departmentName || ""),
  ].join("|");
}

/**
 * Build CheckKeywords frame matching production format exactly:
 * {
 *   "type": 1,
 *   "target": "CheckKeywords",
 *   "sessionId": "SESS-xxx",     ← top-level (read by _extract_session_id)
 *   "arguments": [
 *     [{requestId, keyword, proxy, country, departmentId, departmentName, deviceId}],
 *     {"deviceId":"...", "targetDeviceId":"...", "sessionId":"..."}
 *   ]
 * }
 */
function buildCheckKeywordsFrame(
  items: unknown[],
  targetDeviceId: string,
  sessionId: string
): string {
  const msg = {
    type: 1,
    target: "CheckKeywords",
    sessionId,           // top-level for _extract_session_id
    arguments: [
      items,
      { deviceId: targetDeviceId, targetDeviceId, sessionId },
    ],
  };
  return JSON.stringify(msg) + RECORD_SEP;
}

// ─── State snapshot ───────────────────────────────────────────────────────────

api.get("/state", (c) => {
  return c.json(store.snapshot());
});

// ─── Pool list ────────────────────────────────────────────────────────────────

api.get("/pools", (c) => {
  const pools = [...store.pools.values()].map((p) => ({
    connectionId: p.connectionId,
    poolId: p.poolId,
    nodeId: p.nodeId,
    deviceCount: p.devices.size,
    devices: [...p.devices.values()].map((d) => ({
      deviceId: d.deviceId,
      model: d.model,
      name: d.name,
      status: d.status,
    })),
    connectedAt: p.connectedAt,
    lastSeen: p.lastSeen,
  }));
  return c.json({ pools });
});

// ─── Send keywords ────────────────────────────────────────────────────────────
//
// Request body:
//   { connectionId, deviceId, keywords:[], proxy?, country?, departmentId?, departmentName?, sessionId? }
//
// Sends CheckKeywords to app in production format:
//   arguments[0] = [{requestId, keyword, proxy:[], country, departmentId, departmentName, deviceId}]
//   arguments[1] = {deviceId, targetDeviceId, sessionId}

api.post("/send-keywords", async (c) => {
  let body: SendKeywordsRequest;
  try {
    body = await c.req.json<SendKeywordsRequest>();
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  const {
    connectionId, deviceId, keywords,
    proxy = "", country = 1,
    departmentId = "", departmentName = "",
    sessionId: reqSessionId,
  } = body;

  if (!connectionId || !deviceId || !keywords?.length) {
    return c.json({ error: "connectionId, deviceId, keywords required" }, 400);
  }

  // sessionId format matches STG: SESS-{timestamp}-{4-digit zero-padded}
  const sessionId = reqSessionId || `SESS-${Date.now()}-${String(Math.floor(Math.random() * 9000) + 1000)}`;

  // Build items array matching STG production format exactly.
  // App resolves device via arguments[1].targetDeviceId — not from items.
  const items = keywords.map((kw) => ({
    requestId: buildRequestId({ keyword: kw, country, proxy, departmentId, departmentName }),
    keyword: kw,
    proxy: proxy ? [proxy] : [],   // app reads proxy[0] as the proxy string
    country,
    departmentId,
    departmentName,
    deviceId: null,
  }));

  const frame = buildCheckKeywordsFrame(items, deviceId, sessionId);

  const ok = sendToApp(connectionId, frame);
  if (!ok) return c.json({ error: "connection not found" }, 404);

  console.log(`[api] CheckKeywords → cid=${connectionId} device=${deviceId} kw=${keywords.length} session=${sessionId}`);
  return c.json({ ok: true, sent: items.length, sessionId });
});

// ─── Device command ───────────────────────────────────────────────────────────
// Sends device_command invocation to app (camelCase fields, app expects these exact names):
//   { command, deviceId, model, name, issuedAt }

api.post("/device-command", async (c) => {
  let body: DeviceCommandRequest;
  try {
    body = await c.req.json<DeviceCommandRequest>();
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  const { connectionId, deviceId, command } = body;
  if (!connectionId || !deviceId || !command) {
    return c.json({ error: "connectionId, deviceId, command required" }, 400);
  }

  const pool = store.pools.get(connectionId);
  const dev = pool?.devices.get(deviceId);

  // Standard SignalR type:1 invocation with camelCase payload (as app expects)
  const msg = {
    type: 1,
    target: "device_command",
    arguments: [{
      command: command.toUpperCase(),
      deviceId,
      model: dev?.model ?? "",
      name: dev?.name ?? deviceId,
      issuedAt: new Date().toISOString(),
    }],
  };
  const frame = JSON.stringify(msg) + RECORD_SEP;

  const ok = sendToApp(connectionId, frame);
  if (!ok) return c.json({ error: "connection not found" }, 404);

  console.log(`[api] device_command → cid=${connectionId} device=${deviceId} cmd=${command}`);
  return c.json({ ok: true });
});

export default api;
