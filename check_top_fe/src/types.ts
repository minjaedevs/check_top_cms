// ─── Mirrored from BE ─────────────────────────────────────────────────────────

export type DeviceStatus = "idle" | "processing" | "failed" | "recovering" | "done" | "offline";
export type StepStatus = "running" | "success" | "failed";
export type WsStatus = "connecting" | "open" | "closed" | "error";

export interface DeviceSerialized {
  deviceId: string;
  model: string;
  name: string;
  status: DeviceStatus;
  jobId: string | null;
  batchId: string | null;
  retryCount: number;
  lastUpdated: number;
}

export interface PoolSerialized {
  connectionId: string;
  labId: string;
  machineId: string;
  devices: DeviceSerialized[];
  connectedAt: number;
  lastSeen: number;
}

export interface StepLog {
  ts: number;
  connectionId: string;
  deviceId: string;
  jobId: string | null;
  batchId: string | null;
  step: string;
  status: StepStatus;
  detail?: string;
}

export interface SerpItem {
  title: string;
  link: string;
  position: number;
  domain?: string;
}

export interface KeywordResult {
  ts: number;
  connectionId: string;
  deviceId: string;
  jobId: string | null;
  batchId: string | null;
  keyword: string;
  status: "success" | "failed";
  topDomain: string | null;
  topPosition?: number | null;
  serp: SerpItem[];
  failReason?: string;
}

// ─── Session record (one per CheckKeywords send from the dashboard) ──────────

export type SessionStatus = "pending" | "success" | "failed";

export interface SessionRecord {
  sessionId: string;
  /** Groups all khu sent together from one modal action. Falls back to sessionId. */
  batchSendId: string;
  deptId: string;
  deptName: string;
  deptColor: string;
  connectionId: string;
  deviceId: string;
  deviceName: string;
  keywords: string[];
  sentAt: number;
  status: SessionStatus;
  results: KeywordResult[];
  finishedAt: number | null;
}

export interface Stats {
  totalJobs: number;
  successJobs: number;
  failedJobs: number;
  retryJobs: number;
  totalKeywords: number;
  successKeywords: number;
  failedKeywords: number;
}

export interface StateSnapshot {
  pools: PoolSerialized[];
  logs: StepLog[];
  results: KeywordResult[];
  stats: Stats;
}

// ─── WS messages from server ─────────────────────────────────────────────────

export type DashboardMessage =
  | { type: "snapshot"; data: StateSnapshot }
  | { type: "pool_update"; data: PoolSerialized }
  | { type: "pool_remove"; connectionId: string }
  | { type: "device_update"; connectionId: string; device: DeviceSerialized }
  | { type: "step_log"; data: StepLog }
  | { type: "keyword_result"; data: KeywordResult }
  | { type: "stats"; data: Stats };
