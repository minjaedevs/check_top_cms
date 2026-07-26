import { useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import type { DashboardMessage } from "../types";

const WS_URL =
  (import.meta as unknown as { env?: { VITE_WS_URL?: string } }).env?.VITE_WS_URL ??
  `ws://${window.location.hostname}:3007/ws/dashboard`;

const PING_INTERVAL_MS = 20_000;
const RECONNECT_DELAY_MS = 3_000;

export function useWebSocket() {
  const setWsStatus = useStore((s) => s.setWsStatus);
  const applyMessage = useStore((s) => s.applyMessage);
  const wsRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  function clearTimers() {
    if (pingRef.current) clearInterval(pingRef.current);
    if (reconnectRef.current) clearTimeout(reconnectRef.current);
  }

  function connect() {
    if (!mountedRef.current) return;
    setWsStatus("connecting");

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus("open");
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as DashboardMessage;
        applyMessage(msg);
      } catch {
        /* ignore malformed */
      }
    };

    ws.onclose = () => {
      setWsStatus("closed");
      clearTimers();
      // Only reconnect if THIS ws is still the current one.
      // Guards against StrictMode double-effect: WS1 closes after WS2 already opened
      // → wsRef.current === ws2 !== ws1 → no stale reconnect → no duplicate connections.
      if (mountedRef.current && wsRef.current === ws) {
        reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };

    ws.onerror = () => {
      setWsStatus("error");
    };
  }

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      clearTimers();
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
