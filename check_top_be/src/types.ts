// ─── Device / Pool ───────────────────────────────────────────────────────────

export type DeviceStatus =
  | "idle"
  | "processing"
  | "failed"
  | "recovering"
  | "done"
  | "offline";   // device unplugged but connection pool still alive

export interface Device {
  deviceId: string;       // ADB serial, e.g. "emulator-5554"
  model: string;
  name: string;           // friendly name, e.g. "Samsung S21 Lab #1"
  status: DeviceStatus;
  jobId: string | null;   // requestId or sessionId of current job
  batchId: string | null;
  retryCount: number;     // keyword retry count (TH2a)
  lastUpdated: number;
}

export interface Pool {
  connectionId: string;   // WebSocket id of the app connection
  poolId: string;         // from register_pool payload.poolId → displayed as labId
  nodeId: string;         // PC node deviceId (top-level msg.deviceId)
  secret: string;
  devices: Map<string, Device>;
  connectedAt: number;
  lastSeen: number;
}

// ─── Session (one per app WS connection) ─────────────────────────────────────

export interface Session {
  connectionId: string;
  ws: WebSocket;
  pool: Pool;
}

// ─── Step log ────────────────────────────────────────────────────────────────

export type StepStatus = "running" | "success" | "failed";

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

// ─── Keyword result (from SubmitMobileResult) ────────────────────────────────

export interface SerpItem {
  title: string;
  link: string;
  position: number;
}

export interface KeywordResult {
  ts: number;
  connectionId: string;
  deviceId: string;
  jobId: string | null;   // requestId
  batchId: string | null;
  keyword: string;        // keyword if known; requestId prefix otherwise
  status: "success" | "failed";
  topDomain: string | null;
  topPosition: number | null;  // best position from items[0]
  serp: SerpItem[];
  failReason?: string;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface Stats {
  totalJobs: number;
  successJobs: number;
  failedJobs: number;
  retryJobs: number;
  totalKeywords: number;
  successKeywords: number;
  failedKeywords: number;
}

// ─── Dashboard snapshot (what FE receives) ───────────────────────────────────

export interface PoolSerialized {
  connectionId: string;
  labId: string;      // = poolId
  machineId: string;  // = nodeId (PC)
  devices: DeviceSerialized[];
  connectedAt: number;
  lastSeen: number;
}

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

export interface StateSnapshot {
  pools: PoolSerialized[];
  logs: StepLog[];
  results: KeywordResult[];
  stats: Stats;
}

// ─── SignalR event payloads (C→S from app) — camelCase matching app format ───

/**
 * register_pool
 * App sends via _register_pool():
 *   { event:"register_pool", target:"register_pool", deviceId:"PC-NODE", payload:{ poolId, devices:[{deviceId,name,model}] } }
 */
export interface RegisterPoolPayload {
  poolId: string;
  devices: Array<{
    deviceId: string;
    name?: string;
    model?: string;
  }>;
  // top-level msg fields (resolved before passing here)
  _nodeDeviceId?: string;
}

/**
 * device_status
 * App sends: { payload:{ deviceId, status:"online"/"idle"/"offline"/"busy", poolId } }
 */
export interface DeviceStatusPayload {
  deviceId: string;
  status: string;           // "online" | "idle" | "offline" | "busy"
  sessionId?: string;
  batchId?: string;
}

/**
 * job_start
 * App sends: { payload:{ deviceId, sessionId, batchId, action, keywordsCount } }
 */
export interface JobStartPayload {
  deviceId: string;
  sessionId?: string;
  batchId?: string;
  action?: string;
  keywordsCount?: number;
  keyword?: string;
  /** App nests batchId + dept info inside metadata instead of top-level fields */
  metadata?: {
    batchId?: string;
    departmentId?: string;
    departmentName?: string;
    keywordsCount?: number;
    receivedAtMs?: number;
  };
}

/**
 * step_change
 * App sends: { payload:{ deviceId, currentStep, keyword, requestId, batchId, sessionId } }
 */
export interface StepChangePayload {
  deviceId: string;
  currentStep: string;      // e.g. "OPEN_BROWSER", "SEARCH_KEYWORD"
  keyword?: string;
  requestId?: string;
  batchId?: string;
  sessionId?: string;
  detail?: string;
}

/**
 * SubmitMobileResult (standard SignalR type:1)
 * App sends: { type:1, target:"SubmitMobileResult", arguments:[{requestId, deviceId, poolId, items[], publicIp, sourceName}] }
 * items[]: { top, position, rank, title, url, domain }
 * No status field — success if items.length > 0, failed if empty
 */
export interface SubmitResultItem {
  top?: number;
  position?: number;
  rank?: number;
  title: string;
  url: string;
  domain: string;
}

export interface SubmitMobileResultPayload {
  requestId: string;
  deviceId: string;
  poolId?: string;
  items: SubmitResultItem[];
  publicIp?: string;
  sourceName?: string;
  mobileImageUrl?: string;
  checkedAt?: number;
  sessionId?: string;   // lab session ID — echoed back so FE can match results to correct session
  // keyword is not sent by app in SubmitMobileResult
}

/**
 * job_success
 * App sends: { payload:{ deviceId, sessionId, totalKeywords, videoPath } }
 */
export interface JobSuccessPayload {
  deviceId: string;
  sessionId?: string;
  batchId?: string;
  totalKeywords?: number;
  videoPath?: string;
}

/**
 * job_failed
 * App sends: { payload:{ deviceId, sessionId, reason } }
 * reason: "keyword_failed" | "device_not_found" | "missing_full_video" | "hls_failed"
 */
export interface JobFailedPayload {
  deviceId: string;
  sessionId?: string;
  batchId?: string;
  reason?: string;          // "keyword_failed" | "device_not_found" | "missing_full_video" | "hls_failed"
  /** Failed keyword details for TH3 server-triggered retry. */
  failedItems?: Array<{ requestId: string; keyword: string }>;
}

/**
 * device_fail_recovery_start (Option 2 — C→S explicit signal)
 * App sends immediately when a mid-job device goes offline,
 * BEFORE the 30s internal-recovery window begins.
 * Server starts a 60s safety timeout; if BatchDeviceError never arrives
 * (e.g. app crash), server acts as fallback watchdog.
 */
export interface DeviceFailRecoveryStartPayload {
  deviceId: string;      // the device that went offline
  sessionId?: string;    // lab session in progress
  batchId?: string;      // batch in progress
  windowMs?: number;     // hint: how long app will wait (default 30 000)
}

// ─── TH2b cross-PC forwarding types ─────────────────────────────────────────

/** A single keyword item in CheckKeywords format (for cross-PC forwarding). */
export interface KhuItem {
  requestId: string;
  keyword: string;
  proxy: string[];
  country: number;
  departmentId: string;
  departmentName: string;
  deviceId: null;
}

/** Full khu data (all keywords) for cross-PC forwarding. */
export interface KhuData {
  departmentId: string;
  departmentName: string;
  items: KhuItem[];
}

/**
 * BatchDeviceError (C→S event for TH2b)
 * App sends: { payload:{ deviceId, sessionId, batchId, status, deviceId_new? } }
 *
 * status=REASSIGNED:         client handled internally — server logs only
 * status=NO_ELIGIBLE_DEVICE: client found no eligible device — server takes over
 *   → remainingItems: partial remaining keywords of current khu (for ForceReassignDevice)
 *   → allKhus: full keyword data for ALL khus device was responsible for (for cross-PC)
 *   → currentDeptId: department_id of the currently running khu
 */
export interface BatchDeviceErrorPayload {
  deviceId: string;
  sessionId?: string;
  batchId?: string;
  status: "REASSIGNED" | "NO_ELIGIBLE_DEVICE";
  deviceId_new?: string;    // set when status=REASSIGNED
  error?: string;
  // NO_ELIGIBLE_DEVICE fields:
  currentDeptId?: string;      // department_id of the currently running khu
  remainingItems?: KhuItem[];  // partial remaining of current khu (for ForceReassignDevice same-PC)
  allKhus?: KhuData[];         // full khu data for ALL khus (for cross-PC CheckKeywords)
}

/**
 * QueryEligibleDevice (S→C) — server asks other clients for eligible device.
 * Client runs DK1/2/3 locally and responds with EligibleDeviceResponse.
 */
export interface QueryEligibleDevicePayload {
  queryId: string;
  departmentId: string;   // khu that needs handling
  remainingCount: number; // how many keywords remain (for DK3)
  sessionId?: string;
}

/**
 * EligibleDeviceResponse (C→S) — client responds to QueryEligibleDevice.
 */
export interface EligibleDeviceResponsePayload {
  queryId: string;
  eligible: boolean;
  deviceId?: string;  // which device is eligible (if any)
}

/**
 * ForceReassignDevice (S→C) — server tells same-pool client to force-assign
 * remaining keywords to any available device (ignores DK conditions).
 * Only sends remainingItems of the CURRENT khu (not pending khus — they are
 * still in the client's internal queue).
 */
export interface ForceReassignDevicePayload {
  queryId: string;
  originalDeviceId: string;
  departmentId: string;
  departmentName: string;
  sessionId?: string;
  batchId?: string;
  remainingItems: KhuItem[];
}

// ─── Dashboard WS messages (S→FE) ────────────────────────────────────────────

export type DashboardMessage =
  | { type: "snapshot"; data: StateSnapshot }
  | { type: "pool_update"; data: PoolSerialized }
  | { type: "pool_remove"; connectionId: string }
  | { type: "device_update"; connectionId: string; device: DeviceSerialized }
  | { type: "step_log"; data: StepLog }
  | { type: "keyword_result"; data: KeywordResult }
  | { type: "stats"; data: Stats };

// ─── API request bodies ───────────────────────────────────────────────────────

export interface SendKeywordsRequest {
  connectionId: string;
  deviceId: string;         // target device serial
  sessionId?: string;
  keywords: string[];
  proxy?: string;
  country?: number;
  departmentId?: string;
  departmentName?: string;
}

export interface DeviceCommandRequest {
  connectionId: string;
  deviceId: string;
  command: "PAUSE" | "RESUME" | "CANCEL" | "RECOVER";
}
