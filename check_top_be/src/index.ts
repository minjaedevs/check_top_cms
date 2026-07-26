/**
 * check-top-server — main entry
 *
 * Endpoints:
 *   WS   /hubs/mobile-check                          → check_top-app (SignalR JSON v1)
 *   WS   /ws/dashboard                               → React dashboard (plain JSON)
 *
 *   GET  /health                                     → 200 ok
 *   GET  /api/state                                  → full snapshot
 *   GET  /api/pools                                  → pool list
 *   POST /api/send-keywords                          → push CheckKeywords to device
 *   POST /api/device-command                         → send device_command
 *
 *   POST /api/integration/video/upload-chunk         → mock upload (returns 200)
 *   POST /api/integration/video/merge-chunks         → mock merge  (returns fake path)
 *   POST /api/integration/video/upload-v2            → mock record (returns fake URL)
 *   POST /api/integration/video/presign-m3u8-segments→ mock presign (returns empty list)
 *
 * Run:  bun run dev
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { appWsHandlers, websocket } from "./handlers/app-ws";
import { dashWsHandlers } from "./handlers/dashboard-ws";
import api from "./routes/api";

const PORT = parseInt(process.env.PORT ?? "3007", 10);

const app = new Hono();

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use("*", cors());
app.use("*", logger());

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ status: "ok", ts: Date.now() }));

// ─── Dashboard API ────────────────────────────────────────────────────────────

app.route("/api", api);

// ─── Mock video upload endpoints (UPLOAD_API_BASE = localhost:3003) ───────────
// The app sends real multipart/JSON requests here. In LOCAL demo mode we just
// accept them and return minimal fake responses so the app can call job_success
// without crashing. No actual file is stored anywhere.

/** Step 1: upload chunk — just needs HTTP 200 */
app.post("/api/integration/video/upload-chunk", async (c) => {
  const uploadId = c.req.query("uploadId") ?? "demo";
  const chunkIndex = c.req.query("chunkIndex") ?? "0";
  console.log(`[upload-mock] upload-chunk uploadId=${uploadId} chunk=${chunkIndex}`);
  return c.json({ ok: true, uploadId, chunkIndex });
});

/** Step 2: merge chunks — app reads originalFilename/mimeType/fileSize/originalFilePath */
app.post("/api/integration/video/merge-chunks", async (c) => {
  const uploadId = c.req.query("uploadId") ?? "demo";
  const filename = c.req.query("originalFilename") ?? "demo.mp4";
  console.log(`[upload-mock] merge-chunks uploadId=${uploadId} file=${filename}`);
  return c.json({
    ok: true,
    uploadId,
    originalFilename: filename,
    mimeType: "video/mp4",
    fileSize: 0,
    originalFilePath: `demo/${filename}`,
  });
});

/** Step 3: upload-v2 — app reads r3.json() and passes to on_done(True, resp) */
app.post("/api/integration/video/upload-v2", async (c) => {
  const _filename = c.req.query("keyword") ?? "demo";
  const fakeUrl = `http://localhost:${PORT}/fake-video/${Date.now()}/index.m3u8`;
  console.log(`[upload-mock] upload-v2 → fake url: ${fakeUrl}`);
  return c.json({
    ok: true,
    url: fakeUrl,
    videoUrl: fakeUrl,
    message: "LOCAL_DEMO — no CDN, fake URL returned",
  });
});

/** HLS presign — app reads segment list; empty list causes a soft fail (acceptable in demo) */
app.post("/api/integration/video/presign-m3u8-segments", async (c) => {
  console.log("[upload-mock] presign-m3u8-segments → returning empty (no CDN in local demo)");
  // Return a non-empty list with a fake uploadUrl so app skips the PUT loop gracefully
  return c.json({
    ok: true,
    segments: [],
    data: [],
    result: [],
  });
});

// ─── WebSocket: check_top-app ─────────────────────────────────────────────────

app.get("/hubs/mobile-check", appWsHandlers());

// ─── WebSocket: React dashboard ───────────────────────────────────────────────

app.get("/ws/dashboard", dashWsHandlers());

// ─── Start ────────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
  websocket,
});

console.log(`\n  check-top-server  http://localhost:${PORT}`);
console.log(`  App WS   → ws://localhost:${PORT}/hubs/mobile-check`);
console.log(`  Dash WS  → ws://localhost:${PORT}/ws/dashboard`);
console.log(`  API      → http://localhost:${PORT}/api/state`);
console.log(`  Upload   → http://localhost:${PORT}/api/integration/video/* (mock)\n`);

// server is started above — no default export (prevents bun from calling Bun.serve() a second time)
