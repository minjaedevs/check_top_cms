import type {
  Pool,
  Device,
  Session,
  StepLog,
  KeywordResult,
  Stats,
  StateSnapshot,
  PoolSerialized,
  DeviceSerialized,
  DashboardMessage,
} from "./types";

const LOG_RING_SIZE = 500;
const RESULT_RING_SIZE = 500;
const DASH_RING_SIZE = 200; // sent in snapshot

class Store {
  pools = new Map<string, Pool>();       // connectionId → Pool
  sessions = new Map<string, Session>(); // connectionId → Session
  dashboardClients = new Set<WebSocket>();

  private logs: StepLog[] = [];
  private results: KeywordResult[] = [];

  stats: Stats = {
    totalJobs: 0,
    successJobs: 0,
    failedJobs: 0,
    retryJobs: 0,
    totalKeywords: 0,
    successKeywords: 0,
    failedKeywords: 0,
  };

  // ─── Pool ──────────────────────────────────────────────────────────────────

  addPool(session: Session): void {
    this.pools.set(session.connectionId, session.pool);
    this.sessions.set(session.connectionId, session);
    this.broadcastDash({ type: "pool_update", data: serializePool(session.pool) });
  }

  removePool(connectionId: string): void {
    this.pools.delete(connectionId);
    this.sessions.delete(connectionId);
    this.broadcastDash({ type: "pool_remove", connectionId });
  }

  touchPool(connectionId: string): void {
    const p = this.pools.get(connectionId);
    if (p) p.lastSeen = Date.now();
  }

  // ─── Device ────────────────────────────────────────────────────────────────

  upsertDevice(connectionId: string, device: Device): void {
    const pool = this.pools.get(connectionId);
    if (!pool) return;
    pool.devices.set(device.deviceId, device);
    this.broadcastDash({
      type: "device_update",
      connectionId,
      device: serializeDevice(device),
    });
  }

  getDevice(connectionId: string, deviceId: string): Device | undefined {
    return this.pools.get(connectionId)?.devices.get(deviceId);
  }

  updateDeviceStatus(
    connectionId: string,
    deviceId: string,
    patch: Partial<Device>
  ): Device | null {
    const pool = this.pools.get(connectionId);
    if (!pool) return null;
    const dev = pool.devices.get(deviceId);
    if (!dev) {
      // Device not in pool yet — app likely sent device_status before register_pool
      // completed.  App should call register_pool first to introduce new devices.
      console.warn(`[store] updateDeviceStatus: device ${deviceId} not in pool cid=${connectionId} — ignored (app should send register_pool first)`);
      return null;
    }
    Object.assign(dev, patch, { lastUpdated: Date.now() });
    this.broadcastDash({
      type: "device_update",
      connectionId,
      device: serializeDevice(dev),
    });
    return dev;
  }

  // ─── Logs ──────────────────────────────────────────────────────────────────

  pushLog(log: StepLog): void {
    this.logs.push(log);
    if (this.logs.length > LOG_RING_SIZE) this.logs.shift();
    this.broadcastDash({ type: "step_log", data: log });
  }

  pushResult(result: KeywordResult): void {
    this.results.push(result);
    if (this.results.length > RESULT_RING_SIZE) this.results.shift();

    this.stats.totalKeywords++;
    if (result.status === "success") this.stats.successKeywords++;
    else this.stats.failedKeywords++;

    this.broadcastDash({ type: "keyword_result", data: result });
    this.broadcastDash({ type: "stats", data: { ...this.stats } });
  }

  incJobSuccess(): void {
    this.stats.totalJobs++;
    this.stats.successJobs++;
    this.broadcastDash({ type: "stats", data: { ...this.stats } });
  }

  incJobFailed(): void {
    this.stats.totalJobs++;
    this.stats.failedJobs++;
    this.broadcastDash({ type: "stats", data: { ...this.stats } });
  }

  incJobRetry(): void {
    this.stats.retryJobs++;
    this.broadcastDash({ type: "stats", data: { ...this.stats } });
  }

  // ─── Dashboard clients ────────────────────────────────────────────────────

  addDashClient(ws: WebSocket): void {
    this.dashboardClients.add(ws);
    // Send full snapshot
    const snapshot = this.snapshot();
    ws.send(JSON.stringify({ type: "snapshot", data: snapshot } satisfies DashboardMessage));
  }

  removeDashClient(ws: WebSocket): void {
    this.dashboardClients.delete(ws);
  }

  broadcastDash(msg: DashboardMessage): void {
    if (this.dashboardClients.size === 0) return;
    const text = JSON.stringify(msg);
    for (const ws of this.dashboardClients) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      } catch {
        // ignore closed sockets
      }
    }
  }

  /** Broadcast a pool_update for a single pool (used after re-registration) */
  broadcastPool(connectionId: string): void {
    const pool = this.pools.get(connectionId);
    if (!pool) return;
    this.broadcastDash({ type: "pool_update", data: serializePool(pool) });
  }

  // ─── Snapshot ─────────────────────────────────────────────────────────────

  snapshot(): StateSnapshot {
    return {
      pools: [...this.pools.values()].map(serializePool),
      logs: this.logs.slice(-DASH_RING_SIZE),
      results: this.results.slice(-DASH_RING_SIZE),
      stats: { ...this.stats },
    };
  }

  // ─── Find device globally (for reassign) ─────────────────────────────────

  findIdleDeviceExcept(excludeConnectionId: string): {
    connectionId: string;
    device: Device;
  } | null {
    for (const [cid, pool] of this.pools) {
      if (cid === excludeConnectionId) continue;
      for (const dev of pool.devices.values()) {
        if (dev.status === "idle") return { connectionId: cid, device: dev };
      }
    }
    return null;
  }
}

// ─── Serializers ──────────────────────────────────────────────────────────────

function serializeDevice(d: Device): DeviceSerialized {
  return {
    deviceId: d.deviceId,
    model: d.model,
    name: d.name,
    status: d.status,
    jobId: d.jobId,
    batchId: d.batchId,
    retryCount: d.retryCount,
    lastUpdated: d.lastUpdated,
  };
}

function serializePool(p: Pool): PoolSerialized {
  return {
    connectionId: p.connectionId,
    labId: p.poolId,    // poolId from app → display as labId
    machineId: p.nodeId, // nodeId (PC deviceId) → display as machineId
    devices: [...p.devices.values()].map(serializeDevice),
    connectedAt: p.connectedAt,
    lastSeen: p.lastSeen,
  };
}

export const store = new Store();
