/**
 * dashboard-ws.ts
 * WebSocket for the React dashboard at /ws/dashboard
 *
 * Protocol: plain JSON (no SignalR)
 * Server → FE: DashboardMessage objects
 * FE → Server: { type: "ping" } keepalive
 */

import { createBunWebSocket } from "hono/bun";
import { store } from "../store";

export const { upgradeWebSocket: upgradeDashWs, websocket: dashWebsocket } =
  createBunWebSocket();

export function dashWsHandlers() {
  return upgradeDashWs((_c) => {
    // Capture ws in closure so onClose can remove it from the store
    let dashWs: WebSocket | null = null;

    return {
      onOpen(_evt, ws) {
        dashWs = ws as unknown as WebSocket;
        console.log("[dash-ws] dashboard client connected");
        store.addDashClient(dashWs);
      },

      onMessage(evt, _ws) {
        // FE may send {"type":"ping"} — silently ignore
        const raw = typeof evt.data === "string" ? evt.data : "";
        if (!raw) return;
        try {
          const msg = JSON.parse(raw);
          if (msg.type !== "ping") {
            console.log("[dash-ws] unexpected message:", msg);
          }
        } catch {
          /* ignore */
        }
      },

      onClose() {
        console.log("[dash-ws] dashboard client disconnected");
        if (dashWs) {
          store.removeDashClient(dashWs);
          dashWs = null;
        }
      },
    };
  });
}
