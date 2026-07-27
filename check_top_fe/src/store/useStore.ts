import { create } from "zustand";
import type {
  PoolSerialized,
  DeviceSerialized,
  StepLog,
  KeywordResult,
  Stats,
  StateSnapshot,
  WsStatus,
  DashboardMessage,
  SessionRecord,
} from "../types";

const MAX_LOGS    = 1000;
const MAX_RESULTS = 500;
const MAX_SESSIONS = 50;

// Step names that finalize a session
const JOB_SUCCESS_STEPS = new Set(["job_success"]);
const JOB_FAILED_STEPS  = new Set(["job_failed", "device_timeout_no_replacement"]);

interface DashStore {
  // Connection
  wsStatus: WsStatus;
  setWsStatus: (s: WsStatus) => void;

  // Data
  pools: PoolSerialized[];
  logs: StepLog[];
  results: KeywordResult[];
  stats: Stats;

  // ── Sessions (local, not synced from BE) ──
  sessions: SessionRecord[];
  addSession: (record: SessionRecord) => void;

  // Actions
  applySnapshot: (snap: StateSnapshot) => void;
  applyMessage: (msg: DashboardMessage) => void;

  // UI
  selectedConnectionId: string | null;
  selectPool: (cid: string | null) => void;
  logsFilter: string;
  setLogsFilter: (f: string) => void;
}

const defaultStats: Stats = {
  totalJobs: 0, successJobs: 0, failedJobs: 0, retryJobs: 0,
  totalKeywords: 0, successKeywords: 0, failedKeywords: 0,
};

// ── Helpers for session tracking ──────────────────────────────────────────────

/**
 * Attach a keyword result to the matching pending session.
 *
 * Match strategy:
 *   1. result.batchId === sess.sessionId  (primary — set by server from sessionId,
 *      works after TH2b cross-device reassignment where deviceId differs)
 *   2. result.deviceId === sess.deviceId  (fallback when batchId not available)
 */
function attachResult(sessions: SessionRecord[], result: KeywordResult): SessionRecord[] {
  let matched = false;
  const updated = sessions.map((sess) => {
    if (matched || sess.status !== "pending") return sess;
    const bySession = result.batchId != null && sess.sessionId === result.batchId;
    const byDevice  = !result.batchId && sess.deviceId === result.deviceId;
    if (bySession || byDevice) {
      matched = true;
      return { ...sess, results: [...sess.results, result] };
    }
    return sess;
  });
  return matched ? updated : sessions;
}

/**
 * Finalize a session from a step_log event.
 *
 * Match strategy:
 *   1. log.jobId === sess.sessionId  (primary — cross-device safe; job_success/job_failed
 *      carry the original sessionId regardless of which device actually ran the job)
 *   2. log.deviceId === sess.deviceId AND no jobId in log  (fallback for legacy events)
 *
 * The old strategy required deviceId to match first, which broke after TH2b reassignment
 * where POCO M7 sends job_success for Samsung's session (different deviceId, same sessionId).
 */
function finalizeSession(
  sessions: SessionRecord[],
  log: StepLog,
  status: "success" | "failed"
): SessionRecord[] {
  const now = Date.now();
  let matched = false;
  const updated = sessions.map((sess) => {
    if (matched || sess.status !== "pending") return sess;

    // Primary: match by sessionId (cross-device safe)
    const byId  = log.jobId != null && sess.sessionId === log.jobId;
    // Fallback: deviceId only when no jobId present in log
    const byDev = !log.jobId && sess.deviceId === log.deviceId;

    if (byId || byDev) {
      matched = true;
      return { ...sess, status, finishedAt: now };
    }
    return sess;
  });
  return matched ? updated : sessions;
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useStore = create<DashStore>((set, get) => ({
  wsStatus: "connecting",
  setWsStatus: (s) => set({ wsStatus: s }),

  pools:    [],
  logs:     [],
  results:  [],
  stats:    { ...defaultStats },
  sessions: [],

  selectedConnectionId: null,
  logsFilter: "",

  selectPool:    (cid) => set({ selectedConnectionId: cid }),
  setLogsFilter: (f)   => set({ logsFilter: f }),

  // ── Add a new session (called by SendKeywordsModal after a successful send) ──
  addSession: (record) =>
    set((s) => ({
      sessions: [record, ...s.sessions].slice(0, MAX_SESSIONS),
    })),

  applySnapshot: (snap) => {
    set({
      pools:   snap.pools,
      logs:    snap.logs.slice(-MAX_LOGS),
      results: snap.results.slice(-MAX_RESULTS),
      stats:   snap.stats,
    });
  },

  applyMessage: (msg) => {
    switch (msg.type) {

      case "snapshot":
        get().applySnapshot(msg.data);
        break;

      case "pool_update": {
        const updated = msg.data;
        set((s) => {
          const exists = s.pools.some((p) => p.connectionId === updated.connectionId);
          return {
            pools: exists
              ? s.pools.map((p) => p.connectionId === updated.connectionId ? updated : p)
              : [...s.pools, updated],
          };
        });
        break;
      }

      case "pool_remove":
        set((s) => ({
          pools: s.pools.filter((p) => p.connectionId !== msg.connectionId),
          selectedConnectionId:
            s.selectedConnectionId === msg.connectionId ? null : s.selectedConnectionId,
        }));
        break;

      case "device_update": {
        const { connectionId, device } = msg;
        set((s) => ({
          pools: s.pools.map((p) => {
            if (p.connectionId !== connectionId) return p;
            const exists = p.devices.some((d) => d.deviceId === device.deviceId);
            return {
              ...p,
              devices: exists
                ? p.devices.map((d) => d.deviceId === device.deviceId ? device : d)
                : [...p.devices, device],
            };
          }),
        }));
        break;
      }

      case "step_log": {
        const log = msg.data;
        set((s) => {
          // Dedup: skip identical log (same ts+cid+deviceId+step).
          // Prevents doubles from StrictMode double-WS or reconnect races.
          const isDup = s.logs.some(
            (l) => l.ts === log.ts && l.connectionId === log.connectionId &&
                   l.deviceId === log.deviceId && l.step === log.step
          );
          if (isDup) return s;
          const newLogs = [...s.logs, log].slice(-MAX_LOGS);
          let newSessions = s.sessions;
          if (JOB_SUCCESS_STEPS.has(log.step)) {
            newSessions = finalizeSession(s.sessions, log, "success");
          } else if (JOB_FAILED_STEPS.has(log.step)) {
            newSessions = finalizeSession(s.sessions, log, "failed");
          }
          return { logs: newLogs, sessions: newSessions };
        });
        break;
      }

      case "keyword_result": {
        const result = msg.data;
        set((s) => ({
          results:  [...s.results, result].slice(-MAX_RESULTS),
          sessions: attachResult(s.sessions, result),
        }));
        break;
      }

      case "stats":
        set({ stats: msg.data });
        break;
    }
  },
}));
