# check_top_be — Tài liệu luồng chạy & WebSocket Events

> **Cập nhật:** 2026-07-26
> **Runtime:** Bun + Hono
> **File chính:** `src/handlers/app-ws.ts` · `src/store.ts` · `src/protocol.ts` · `src/types.ts`

---

## Mục lục

1. [Kiến trúc tổng quan](#1-kiến-trúc-tổng-quan)
2. [Giao thức SignalR JSON v1](#2-giao-thức-signalr-json-v1)
3. [Events C→S (App → Server)](#3-events-cs-app--server)
4. [Events S→C (Server → App)](#4-events-sc-server--app)
5. [Messages S→FE (Server → Dashboard)](#5-messages-sfe-server--dashboard)
6. [Luồng chạy bình thường (Happy path)](#6-luồng-chạy-bình-thường-happy-path)
7. [TH2a — Keyword retry](#7-th2a--keyword-retry)
8. [TH2b — Device fail mid-job](#8-th2b--device-fail-mid-job)
9. [Watchdogs](#9-watchdogs)
10. [Toàn bộ step log names](#10-toàn-bộ-step-log-names)
11. [Store — Cấu trúc dữ liệu in-memory](#11-store--cấu-trúc-dữ-liệu-in-memory)

---

## 1. Kiến trúc tổng quan

```
┌─────────────────────────────────────────────────────────┐
│                   check_top_be (Bun + Hono)             │
│                                                         │
│  /hubs/mobile-check   ◄──────────► App (Python/Android) │
│       app-ws.ts                     SignalR JSON v1     │
│                                                         │
│  /ws/dashboard        ◄──────────► CMS Dashboard (React)│
│       dash-ws.ts                    plain JSON          │
│                                                         │
│  /api/...             ◄──────────► CMS REST API calls   │
│       routes/                                           │
│                                                         │
│  Store (singleton) ──── holds all in-memory state ────  │
└─────────────────────────────────────────────────────────┘
```

### Các thành phần chính

| Thành phần | Mô tả |
|---|---|
| `Store` | Singleton — giữ toàn bộ state: pools, sessions, logs, results, stats |
| `Pool` | Một kết nối WS từ 1 PC app. Chứa nhiều `Device` (thiết bị ADB) |
| `Device` | 1 thiết bị Android vật lý/emulator. Key = `deviceId` (ADB serial) |
| `Session` | Wrapper `{ connectionId, ws, pool }` — dùng để gửi S→C frame |
| `retryMap` | `Map<cid, Map<requestId, retryCount>>` — theo dõi retry TH2a per connection |
| `deviceWatchMap` | `Map<"cid:deviceId", setTimeout>` — watchdog 3 phút per device |
| `recoveryMap` | `Map<"cid:deviceId", setTimeout>` — safety watchdog 60s TH2b |

---

## 2. Giao thức SignalR JSON v1

### Frame format

Mỗi message = **JSON + `\u001e`** (ASCII 30 — record separator).
Một raw string có thể chứa nhiều frames ghép liền nhau.

```
{"type":1,"target":"SubmitMobileResult","arguments":[{...}]}\u001e
```

### Handshake

Khi app kết nối, frame đầu tiên gửi lên:
```json
{"protocol":"json","version":1}
```
Server phản hồi:
```json
{}
```
Sau đó server bắt đầu gửi ping mỗi 15 giây: `{"type":6}`.

### Hai định dạng frame từ App

App gửi **2 format khác nhau** — server xử lý cả hai:

| Format | Ví dụ |
|---|---|
| **Non-standard** | `{"event":"register_pool","target":"register_pool","deviceId":"PC-NODE","payload":{...}}` |
| **Standard SignalR type:1** | `{"type":1,"target":"SubmitMobileResult","arguments":[{...}]}` |
| **Ping** | `{"type":6}` |

**`resolveEventName(msg)`** → lấy `msg.event` hoặc `msg.target`
**`resolvePayload(msg)`** → lấy `msg.payload` hoặc `msg.arguments[0]`

### Format `requestId` (production)

```
encodeURI(keyword)|country|proxy|uuid|departmentId|encodedDeptName
```

Server decode `parts[0]` → keyword thực, `parts[4]` → deptId, `parts[5]` → deptName.

---

## 3. Events C→S (App → Server)

### 3.1 `register_pool` / `on_register_pool`

**Khi nào:** App khởi động hoặc reconnect (kể cả khi cắm thêm thiết bị).
**Format:** Non-standard.

```json
{
  "event": "register_pool",
  "target": "register_pool",
  "deviceId": "PC-NODE-ID",
  "payload": {
    "poolId": "LAB-001",
    "devices": [
      { "deviceId": "emulator-5554", "name": "Samsung S21 Lab #1", "model": "SM-G998B" }
    ]
  }
}
```

**Server xử lý:**

- **Lần đầu (pool chưa tồn tại):**
  - Tạo `Pool` với tất cả device → status `idle`
  - Tạo `Session` giữ `ws` reference
  - Gọi `store.addPool()` → broadcast `pool_update` lên dashboard
  - Khởi tạo `retryMap[cid]`

- **Re-register (pool đã tồn tại — app reconnect / thêm device):**
  - Upsert device mới vào pool
  - Device cũ offline/done → restore về `idle` (cắm lại)
  - Device cũ còn `processing` → **không thay đổi** (job đang chạy, không interrupt)
  - Device bị missing khỏi danh sách mới → `offline` (nếu đang `idle`)
  - Broadcast `pool_update`

**Side effects:**
- `pool_update` → tất cả dashboard clients
- `device_update` → từng device trong pool

---

### 3.2 `device_status`

**Khi nào:** App báo trạng thái thiết bị thay đổi (ADB event, plug/unplug).
**Format:** Non-standard.

```json
{
  "event": "device_status",
  "payload": {
    "deviceId": "emulator-5554",
    "status": "online"
  }
}
```

**Mapping status:**

| App gửi | Server lưu |
|---|---|
| `online` | `idle` |
| `idle` | `idle` |
| `offline` | `offline` |
| `busy` | `processing` |
| `processing` | `processing` |
| `failed` | `failed` |
| `recovering` | `recovering` |
| `done` | `done` |

**Lưu ý quan trọng:**
- Device `offline` → `idle`: server tự clear `jobId`, `batchId`, `retryCount` (thiết bị cắm lại là mới hoàn toàn)
- Nếu pool chưa tồn tại → **bỏ qua** (race condition với `register_pool`)

**Side effects:**
- `device_update` → dashboard

---

### 3.3 `job_start`

**Khi nào:** App nhận lệnh từ server (sau `CheckKeywords` call) và bắt đầu chạy job.
**Format:** Non-standard.

```json
{
  "event": "job_start",
  "payload": {
    "deviceId": "emulator-5554",
    "sessionId": "sess-uuid-001",
    "batchId": "batch-001",
    "action": "check_keyword",
    "keywordsCount": 5,
    "metadata": {
      "batchId": "batch-001",
      "departmentId": "dept-001",
      "departmentName": "KHU%20A",
      "keywordsCount": 5
    }
  }
}
```

**Server xử lý:**
- Device status → `processing`, set `jobId = sessionId`, `batchId`
- Bắt đầu **device watchdog 3 phút** (reset mỗi khi nhận `step_change`)
- Push log `job_start`

**Side effects:**
- `device_update` → dashboard
- `step_log { step: "job_start", status: "running" }` → dashboard

---

### 3.4 `step_change`

**Khi nào:** App báo progress trong job — mỗi bước automation (mở browser, search, v.v.).
**Format:** Non-standard.

```json
{
  "event": "step_change",
  "payload": {
    "deviceId": "emulator-5554",
    "currentStep": "SEARCH_KEYWORD",
    "keyword": "mua bán nhà",
    "requestId": "mua%20b%C3%A1n%20nh%C3%A0|vn|proxy-01|uuid-001|dept-001|KHU%20A",
    "batchId": "batch-001",
    "sessionId": "sess-uuid-001"
  }
}
```

**Server xử lý:**
- **Reset device watchdog 3 phút** (heartbeat — thiết bị vẫn hoạt động)
- Push log với `step = p.currentStep`

**Side effects:**
- `step_log { step: "SEARCH_KEYWORD", status: "running", detail: "kw=\"...\" dept=..." }` → dashboard

---

### 3.5 `SubmitMobileResult`

**Khi nào:** App hoàn thành check 1 keyword — gửi kết quả SERP.
**Format:** Standard SignalR type:1.

```json
{
  "type": 1,
  "target": "SubmitMobileResult",
  "arguments": [{
    "requestId": "mua%20b%C3%A1n%20nh%C3%A0|vn|proxy-01|uuid-001|dept-001|KHU%20A",
    "deviceId": "emulator-5554",
    "poolId": "LAB-001",
    "sessionId": "sess-uuid-001",
    "items": [
      { "top": 1, "position": 1, "title": "...", "url": "https://...", "domain": "example.com" }
    ],
    "publicIp": "1.2.3.4"
  }]
}
```

**Quy tắc:**
- `items.length > 0` → **TH1: Success**
- `items.length === 0` → **TH2a: Failed → retry**

**TH1 — Success:**
- Push `KeywordResult { status: "success", serp: [...], topDomain, topPosition }`
- Xóa entry trong `retryMap` (nếu có)
- Push log `submit_result`
- Không thay đổi device status (job vẫn tiếp tục với keyword kế tiếp)

**TH2a — Failed (xem chi tiết ở mục 7):**
- `retryCount < 2` → gửi `RetryBatch` về app
- `retryCount >= 2` → push log `max_retry_exceeded` (ALERT)

**Side effects:**
- `keyword_result` → dashboard
- `stats` → dashboard (cập nhật `totalKeywords`, `successKeywords`/`failedKeywords`)
- `step_log { step: "submit_result" | "submit_failed" }` → dashboard

---

### 3.6 `job_success`

**Khi nào:** App hoàn thành toàn bộ job batch thành công.
**Format:** Non-standard.

```json
{
  "event": "job_success",
  "payload": {
    "deviceId": "emulator-5554",
    "sessionId": "sess-uuid-001",
    "batchId": "batch-001",
    "totalKeywords": 5
  }
}
```

**Server xử lý:**
- Clear device watchdog
- Device status → `idle`, clear `jobId`, `batchId`
- `stats.totalJobs++`, `stats.successJobs++`
- Push log `job_success`

**Side effects:**
- `device_update` → dashboard
- `stats` → dashboard
- `step_log { step: "job_success", status: "success" }` → dashboard

---

### 3.7 `job_failed`

**Khi nào:** App đóng batch với lỗi (lý do: `keyword_failed`, `device_not_found`, `missing_full_video`, `hls_failed`).

> **Lưu ý:** Đây là **batch failed** (logic lỗi), KHÔNG phải hardware failed.
> Device status về `idle` vì thiết bị vẫn hoạt động — sẵn sàng nhận job mới.

```json
{
  "event": "job_failed",
  "payload": {
    "deviceId": "emulator-5554",
    "sessionId": "sess-uuid-001",
    "batchId": "batch-001",
    "reason": "keyword_failed"
  }
}
```

**Server xử lý:**
- Clear device watchdog
- Device status → `idle`, clear `jobId`, `batchId`, `retryCount = 0`
- `stats.totalJobs++`, `stats.failedJobs++`
- Push log `job_failed`

**Side effects:**
- `device_update` → dashboard
- `stats` → dashboard
- `step_log { step: "job_failed", status: "failed", detail: reason }` → dashboard

---

### 3.8 `recovering_done`

**Khi nào:** App hoàn tất quá trình khôi phục thiết bị (hardware reset, ADB reconnect).
**Format:** Non-standard.

```json
{
  "event": "recovering_done",
  "payload": { "deviceId": "emulator-5554" }
}
```

**Server xử lý:**
- Clear device watchdog
- Device status → `idle`, clear `jobId`, `batchId`, `retryCount = 0`
- Push log `recovering_done`

---

### 3.9 `device_fail_recovery_start`

**Khi nào:** App phát hiện thiết bị đang chạy job bị mất kết nối ADB.
App gửi ngay lập tức trước khi bắt đầu 30s recovery window nội bộ.
**Format:** Non-standard.

```json
{
  "event": "device_fail_recovery_start",
  "payload": {
    "deviceId": "emulator-5554",
    "sessionId": "sess-uuid-001",
    "batchId": "batch-001",
    "windowMs": 30000
  }
}
```

**Server xử lý:**
- Khởi động **safety watchdog** = `windowMs + 30s` (mặc định 60s)
- Push log `device_fail_recovery_start`
- Nếu sau 60s không nhận `BatchDeviceError` → server tự kích hoạt `fireRecoveryFallback()`

**Mục đích:** Phòng trường hợp app crash / hang — server đóng vai backup watchdog.

---

### 3.10 `BatchDeviceError`

**Khi nào:** App báo kết quả sau recovery window:
- `REASSIGNED`: App tự tìm được thiết bị thay thế trong cùng pool
- `NO_ELIGIBLE_DEVICE`: App không tìm được thiết bị nào, nhờ server xử lý

**Format:** Non-standard.

```json
{
  "event": "BatchDeviceError",
  "payload": {
    "deviceId": "emulator-5554",
    "sessionId": "sess-uuid-001",
    "batchId": "batch-001",
    "status": "REASSIGNED",
    "deviceId_new": "emulator-5556"
  }
}
```

**Server xử lý:**
- Cancel safety watchdog (`recoveryMap`)
- Push log `batch_device_error`

**Case `REASSIGNED`:**
1. Mark device gốc → `offline` (không còn phục vụ job)
2. Mark device mới → `processing` với `jobId/batchId` gốc
3. Push log `takeover_reassigned` cho device mới

**Case `NO_ELIGIBLE_DEVICE`:**

Server tìm fallback theo thứ tự ưu tiên:

| Ưu tiên | Điều kiện | Hành động |
|---|---|---|
| 1 | Idle device ở **pool khác** | Gửi `BatchReassignFallback` đến WS của pool kia |
| 2 | Bất kỳ device non-offline trong **cùng pool** | Gửi `BatchReassignFallback + force:true` về pool hiện tại |
| 3 | Không có device nào | Push alert `no_device_globally` lên dashboard |

Với cả 3 case tìm được device: mark device gốc → `offline`, mark replacement → `processing`, push log `takeover_reassigned`.

---

### 3.11 `device_fail_recovery_cancel`

**Khi nào:** App tự xử lý xong recovery, cancel safety watchdog.
**Format:** Non-standard.

```json
{
  "event": "device_fail_recovery_cancel",
  "payload": { "deviceId": "emulator-5554" }
}
```

**Server xử lý:** Xóa entry trong `recoveryMap` → cancel timeout.
Không push log. Không thay đổi state.

---

## 4. Events S→C (Server → App)

Server gửi về app qua cùng WS connection `/hubs/mobile-check`.
Format: Non-standard `{ event, target, payload }`.

---

### 4.1 `RetryBatch`

**Khi nào:** TH2a — keyword check trả về 0 kết quả, còn lượt retry.

```json
{
  "event": "RetryBatch",
  "target": "RetryBatch",
  "payload": {
    "requestId": "mua%20b%C3%A1n%20nh%C3%A0|vn|...",
    "deviceId": "emulator-5554",
    "retryCount": 1,
    "failedKeywords": []
  }
}
```

**App nhận:** Thực hiện lại check cho `requestId` đó.
**Giới hạn:** Tối đa 2 lần retry (retryCount = 1, 2). Lần 3 → `max_retry_exceeded`.

---

### 4.2 `BatchReassignFallback`

**Khi nào:** TH2b — device fail, server dispatch job cho thiết bị thay thế.
Gửi đến WS của pool chứa thiết bị thay thế (có thể là pool khác).

```json
{
  "event": "BatchReassignFallback",
  "target": "BatchReassignFallback",
  "payload": {
    "originalDeviceId": "emulator-5554",
    "fallbackDeviceId": "emulator-5556",
    "fallbackConnectionId": "conn_1700000000000_2",
    "sessionId": "sess-uuid-001",
    "batchId": "batch-001",
    "force": true,
    "reason": "device_timeout"
  }
}
```

| Field | Mô tả |
|---|---|
| `originalDeviceId` | Device bị fail |
| `fallbackDeviceId` | Device thay thế |
| `fallbackConnectionId` | Pool chứa device thay thế |
| `force` | `true` = buộc dùng dù device đang bận (cùng pool fallback) |
| `reason` | `"device_timeout"` hoặc `"recovery_watchdog"` (nếu từ watchdog) |

**App nhận:** Giao job `sessionId/batchId` cho `fallbackDeviceId`.

---

## 5. Messages S→FE (Server → Dashboard)

Dashboard kết nối qua `/ws/dashboard` (plain WebSocket, không dùng SignalR).
Format: JSON plain, không có record separator.

### 5.1 `snapshot`

**Khi nào:** Gửi ngay khi dashboard client kết nối.
Chứa toàn bộ state hiện tại.

```json
{
  "type": "snapshot",
  "data": {
    "pools": [ /* PoolSerialized[] */ ],
    "logs": [ /* StepLog[] — 200 entries mới nhất */ ],
    "results": [ /* KeywordResult[] — 200 entries mới nhất */ ],
    "stats": { "totalJobs": 5, "successJobs": 4, "failedJobs": 1, "retryJobs": 2, "totalKeywords": 25, "successKeywords": 23, "failedKeywords": 2 }
  }
}
```

---

### 5.2 `pool_update`

**Khi nào:** Pool mới đăng ký hoặc re-register (app kết nối/reconnect/cắm thêm device).

```json
{
  "type": "pool_update",
  "data": {
    "connectionId": "conn_1700000000000_1",
    "labId": "LAB-001",
    "machineId": "PC-NODE-ID",
    "devices": [ /* DeviceSerialized[] */ ],
    "connectedAt": 1700000000000,
    "lastSeen": 1700000001000
  }
}
```

---

### 5.3 `pool_remove`

**Khi nào:** App WS disconnect (PC tắt, mạng đứt, v.v.).

```json
{
  "type": "pool_remove",
  "connectionId": "conn_1700000000000_1"
}
```

**FE:** Xóa pool và tất cả device của pool khỏi UI.

---

### 5.4 `device_update`

**Khi nào:** Bất kỳ thay đổi nào trên một device (status, jobId, retryCount, v.v.).
Trigger từ `store.updateDeviceStatus()`.

```json
{
  "type": "device_update",
  "connectionId": "conn_1700000000000_1",
  "device": {
    "deviceId": "emulator-5554",
    "model": "SM-G998B",
    "name": "Samsung S21 Lab #1",
    "status": "processing",
    "jobId": "sess-uuid-001",
    "batchId": "batch-001",
    "retryCount": 0,
    "lastUpdated": 1700000002000
  }
}
```

**Các trường hợp trigger:**
- `device_status` nhận từ app
- `job_start` / `job_success` / `job_failed` / `recovering_done`
- TH2b: mark offline / mark replacement processing
- Re-register: upsert / restore status

---

### 5.5 `step_log`

**Khi nào:** Mỗi khi server gọi `store.pushLog()` — từ handler hoặc server-generated.
Lưu vào ring buffer 500 entries, dashboard nhận real-time.

```json
{
  "type": "step_log",
  "data": {
    "ts": 1700000003000,
    "connectionId": "conn_1700000000000_1",
    "deviceId": "emulator-5554",
    "jobId": "sess-uuid-001",
    "batchId": "batch-001",
    "step": "SEARCH_KEYWORD",
    "status": "running",
    "detail": "kw=\"mua bán nhà\" dept=dept-001"
  }
}
```

---

### 5.6 `keyword_result`

**Khi nào:** Sau mỗi `SubmitMobileResult` — kết quả 1 keyword.

```json
{
  "type": "keyword_result",
  "data": {
    "ts": 1700000004000,
    "connectionId": "conn_1700000000000_1",
    "deviceId": "emulator-5554",
    "jobId": "mua%20b%C3%A1n%20nh%C3%A0|vn|...",
    "batchId": "sess-uuid-001",
    "keyword": "mua bán nhà",
    "status": "success",
    "topDomain": "example.com",
    "topPosition": 1,
    "serp": [
      { "title": "...", "link": "https://...", "position": 1, "domain": "example.com" }
    ]
  }
}
```

**Mapping jobId/batchId:**
- `jobId` = `requestId` từ app (full pipe-delimited string)
- `batchId` = `sessionId` được echo lại để FE match result → session

---

### 5.7 `stats`

**Khi nào:** Sau mỗi `job_success`, `job_failed`, `incJobRetry()`, và sau mỗi keyword result.

```json
{
  "type": "stats",
  "data": {
    "totalJobs": 10,
    "successJobs": 8,
    "failedJobs": 2,
    "retryJobs": 5,
    "totalKeywords": 50,
    "successKeywords": 47,
    "failedKeywords": 3
  }
}
```

**Lưu ý:** Stats là **in-memory only** — reset khi server restart.

---

## 6. Luồng chạy bình thường (Happy path)

```
App                          Server                        Dashboard (FE)
 │                              │                               │
 │──register_pool──────────────►│                               │
 │                              │──pool_update─────────────────►│
 │                              │──device_update (idle)────────►│
 │                              │                               │
 │   [User gửi từ CMS]          │                               │
 │◄─────────────────────────────│◄──POST /api/send-keywords─────│
 │                              │                               │
 │──job_start──────────────────►│                               │
 │                              │──device_update (processing)──►│
 │                              │──step_log (job_start)────────►│
 │                              │                               │
 │──step_change (OPEN_BROWSER)─►│                               │
 │                              │──step_log (OPEN_BROWSER)─────►│
 │──step_change (SEARCH_KW)────►│                               │
 │                              │──step_log (SEARCH_KW)────────►│
 │──SubmitMobileResult─────────►│                               │
 │   items=[{...}] (success)    │──keyword_result──────────────►│
 │                              │──step_log (submit_result)────►│
 │                              │──stats───────────────────────►│
 │                              │                               │
 │  [repeat per keyword]        │                               │
 │                              │                               │
 │──job_success────────────────►│                               │
 │                              │──device_update (idle)────────►│
 │                              │──step_log (job_success)──────►│
 │                              │──stats───────────────────────►│
```

---

## 7. TH2a — Keyword retry

**Điều kiện:** `SubmitMobileResult` với `items.length === 0` (SERP rỗng).
**Giới hạn:** 2 lần retry per `requestId`.

```
App                         Server                       Dashboard
 │                              │                              │
 │──SubmitMobileResult─────────►│                              │
 │   items=[] (failed)          │──keyword_result (failed)────►│
 │                              │──step_log (submit_failed)───►│
 │                              │──stats──────────────────────►│
 │                              │
 │◄─RetryBatch (retry=1)────────│
 │
 │  [App thử lại cùng requestId]
 │
 │──SubmitMobileResult─────────►│                              │
 │   items=[] (failed again)    │──keyword_result (failed)────►│
 │                              │──step_log (submit_failed retry=1/2)►│
 │◄─RetryBatch (retry=2)────────│
 │
 │  [App thử lần cuối]
 │
 │──SubmitMobileResult─────────►│
 │   items=[] (still failed)    │──step_log (max_retry_exceeded ALERT)►│
 │                              │  (Không gửi RetryBatch nữa)
 │
 │──job_failed─────────────────►│  [App đóng job với lỗi]
```

**Lưu ý:**
- `retryMap[cid][requestId]` track per-request retry count
- Mỗi lần retry: `stats.retryJobs++`, `device.retryCount` tăng
- Sau khi thành công hoặc vượt giới hạn: xóa entry, `device.retryCount = 0`
- `max_retry_exceeded` chỉ là ALERT log — **không** gọi `incJobFailed()` (tránh double-count với `job_failed` sắp tới)

---

## 8. TH2b — Device fail mid-job

**Điều kiện:** Thiết bị mất kết nối ADB trong khi đang chạy job.

### 8.1 Luồng Option A — App xử lý được (REASSIGNED)

App tìm được thiết bị thay thế trong cùng pool:

```
App                          Server                       Dashboard
 │                              │                              │
 │  [Device bị rút]             │                              │
 │──device_fail_recovery_start─►│                              │
 │   (windowMs=30000)           │──step_log (device_fail_recovery_start)►│
 │                              │  [Start safety watchdog 60s]
 │
 │  [App thử kết nối lại 30s]
 │  [Tìm được device mới]
 │
 │──BatchDeviceError───────────►│
 │   status=REASSIGNED          │  [Cancel safety watchdog]
 │   deviceId_new=emulator-5556 │──step_log (batch_device_error)──────►│
 │                              │──device_update (Samsung → offline)──►│
 │                              │──device_update (W4WK → processing)──►│
 │                              │──step_log (takeover_reassigned W4WK)►│
 │
 │  [W4WK tiếp tục chạy job của Samsung]
 │──step_change (deviceId=W4WK)►│
 │──SubmitMobileResult─────────►│
 │──job_success────────────────►│
```

### 8.2 Luồng Option B — App không tìm được thiết bị (NO_ELIGIBLE_DEVICE)

```
App                          Server                       Dashboard
 │──BatchDeviceError───────────►│
 │   status=NO_ELIGIBLE_DEVICE  │  [Cancel safety watchdog]
 │                              │
 │                              │  [Tìm idle device pool khác]
 │                              │  [Tìm thấy: W4WK ở conn_2]
 │◄─BatchReassignFallback───────│ (gửi đến ws của conn_2)
 │   fallbackDeviceId=W4WK      │──device_update (Samsung → offline)──►│
 │   fallbackConnectionId=conn_2│──device_update (W4WK → processing)──►│
 │                              │──step_log (takeover_reassigned W4WK)►│
```

### 8.3 Luồng Option C — Safety watchdog timeout (App crash / hang)

```
[60 giây trôi qua, không nhận được BatchDeviceError]

Server                       Dashboard
 │                              │
 │  [fireRecoveryFallback()]    │
 │──step_log (recovery_watchdog_timeout)►│
 │  [Tìm replacement...]        │
 │──device_update (original → offline)──►│
 │──device_update (fallback → processing)►│
 │──step_log (takeover_reassigned)──────►│
 │◄─BatchReassignFallback (gửi đến app của pool có fallback)
```

### 8.4 Priority tìm fallback device

```
1. Idle device ở pool KHÁC (khác connectionId)
   → Gửi BatchReassignFallback đến ws của pool đó
   → Nếu ws pool đó không available → gửi về pool gốc

2. Non-offline device ở CÙNG pool (force=true)
   → Gửi BatchReassignFallback về pool gốc với force:true
   → App phải dùng device này dù nó đang bận

3. Không có device nào
   → Push step_log "no_device_globally" (ALERT) lên dashboard
```

---

## 9. Watchdogs

### 9.1 Device Watchdog (3 phút)

**Key:** `${cid}:${deviceId}` trong `deviceWatchMap`
**Timeout:** 3 phút = 180,000ms
**Reset khi:** Nhận `step_change` (heartbeat)
**Start khi:** `job_start`
**Clear khi:** `job_success`, `job_failed`, `recovering_done`

**Khi timeout (`fireDeviceTimeout`):**
1. Device status → `failed`, push log `device_timeout`
2. Tìm fallback device (ưu tiên cùng pool idle → pool khác idle)
3. Gửi `BatchReassignFallback` (với `reason: "device_timeout"`)
4. Mark device gốc → `offline`, mark replacement → `processing`
5. Push log `device_timeout_reassigned` + `takeover_reassigned`

**Nếu không tìm được replacement:**
- Push alert `device_timeout_no_replacement` lên dashboard

---

### 9.2 Recovery Watchdog (60 giây)

**Key:** `${cid}:${deviceId}` trong `recoveryMap`
**Timeout:** `windowMs + 30s` (default 30s + 30s = 60s)
**Start khi:** `device_fail_recovery_start`
**Clear khi:** `BatchDeviceError` hoặc `device_fail_recovery_cancel`

**Khi timeout (`fireRecoveryFallback`):**
- Logic giống hệt `onBatchDeviceError` NO_ELIGIBLE_DEVICE branch
- Push log `recovery_watchdog_timeout` trước khi xử lý fallback

---

## 10. Toàn bộ step log names

Step log có `step` là string tự do — dưới đây là tất cả các giá trị được emit:

### App-generated (từ app Python gửi lên qua `step_change`)

App tự định nghĩa các step name (ví dụ: `OPEN_BROWSER`, `SEARCH_KEYWORD`, `WAIT_RESULTS`, v.v.)
Server không validate, forward thẳng vào log.

### Server-generated (server tự push qua `store.pushLog()`)

| Step name | Status | Nguồn | Ý nghĩa |
|---|---|---|---|
| `job_start` | `running` | `onJobStart` | Job bắt đầu chạy |
| `submit_result` | `success` | `onSubmitResult` (TH1) | 1 keyword check thành công |
| `submit_failed` | `failed` | `onSubmitResult` (TH2a) | Keyword trả về 0 kết quả, sẽ retry |
| `max_retry_exceeded` | `failed` | `onSubmitResult` (TH2a) | Vượt quá 2 lần retry — ALERT |
| `job_success` | `success` | `onJobSuccess` | Toàn bộ job thành công |
| `job_failed` | `failed` | `onJobFailed` | Batch đóng với lỗi |
| `recovering_done` | `success` | `onRecoveringDone` | Hardware recovery hoàn tất |
| `batch_device_error` | `failed` | `onBatchDeviceError` | App báo TH2b với status |
| `takeover_reassigned` | `running` | `onBatchDeviceError` / `fireRecoveryFallback` / `fireDeviceTimeout` | Device B đang chạy thay cho device A (log gắn vào device B) |
| `batch_reassign_fallback_same_pool` | `running` | `onBatchDeviceError` (force same pool) | Fallback force về cùng pool |
| `device_fail_recovery_start` | `running` | `onDeviceFailRecoveryStart` | App báo bắt đầu recovery window |
| `recovery_watchdog_timeout` | `failed` | `fireRecoveryFallback` | Watchdog hết hạn, app không gửi BatchDeviceError |
| `recovery_watchdog_reassigned` | `running` | `fireRecoveryFallback` (found) | Watchdog tìm được device cross-pool |
| `recovery_watchdog_force_fallback` | `running` | `fireRecoveryFallback` (anyActive) | Watchdog force fallback cùng pool |
| `no_device_globally` | `failed` | `onBatchDeviceError` / `fireRecoveryFallback` | ALERT — không có device nào toàn hệ thống |
| `device_timeout` | `failed` | `fireDeviceTimeout` | Device không gửi step_change 3 phút |
| `device_timeout_reassigned` | `failed` | `fireDeviceTimeout` (found) | Watchdog 3 phút tìm được replacement |
| `device_timeout_no_replacement` | `failed` | `fireDeviceTimeout` (no fallback) | ALERT — 3 phút timeout, không có replacement |

### Step đặc biệt: `takeover_reassigned`

Log này được gắn vào **device thay thế** (không phải device gốc).
`detail` = `"Chạy thay [tên device gốc]"`
Dùng để FE hiển thị "Borrowed session card" trong cột của device thay thế.

---

## 11. Store — Cấu trúc dữ liệu in-memory

```
Store {
  pools:           Map<connectionId, Pool>
  sessions:        Map<connectionId, Session>   // giữ ws reference
  dashboardClients: Set<WebSocket>

  logs:            StepLog[]   // ring buffer 500 entries
  results:         KeywordResult[]  // ring buffer 500 entries

  stats: {
    totalJobs, successJobs, failedJobs, retryJobs,
    totalKeywords, successKeywords, failedKeywords
  }
}

Pool {
  connectionId: string     // server-generated, e.g. "conn_1700000000000_1"
  poolId: string           // từ register_pool payload.poolId (hiển thị là labId)
  nodeId: string           // PC identifier (top-level msg.deviceId)
  devices: Map<deviceId, Device>
  connectedAt: number
  lastSeen: number         // cập nhật mỗi khi nhận bất kỳ message nào
}

Device {
  deviceId: string         // ADB serial, e.g. "emulator-5554"
  model: string
  name: string
  status: "idle" | "processing" | "failed" | "recovering" | "done" | "offline"
  jobId: string | null     // sessionId hoặc requestId của job hiện tại
  batchId: string | null
  retryCount: number       // TH2a retry count
  lastUpdated: number
}
```

### Ring buffer sizes

| Buffer | Kích thước lưu nội bộ | Kích thước gửi trong snapshot |
|---|---|---|
| logs | 500 entries | 200 entries mới nhất |
| results | 500 entries | 200 entries mới nhất |

### Serialization (Pool → FE)

```typescript
Pool.poolId  → PoolSerialized.labId
Pool.nodeId  → PoolSerialized.machineId
```

---

## Phụ lục — Ví dụ flow đầy đủ TH2b REASSIGNED

```
Timeline:
  t=0s   Samsung chạy job KHU C, step_change liên tục
  t=30s  Samsung bị rút dây USB
  t=30s  App phát hiện ADB disconnect → gửi device_fail_recovery_start
  t=30s  Server start safety watchdog 60s
  t=35s  App thử kết nối lại Samsung → thất bại
  t=40s  App tìm W4WK (idle, cùng pool) → giao job
  t=40s  App gửi BatchDeviceError {status: REASSIGNED, deviceId_new: W4WK}
  t=40s  Server:
           - Cancel safety watchdog
           - Push batch_device_error
           - Mark Samsung → offline (jobId=null)
           - Mark W4WK → processing (jobId=session Samsung)
           - Push takeover_reassigned (deviceId=W4WK, detail="Chạy thay Samsung")
  t=41s+ W4WK gửi step_change, SubmitMobileResult với deviceId=W4WK
  t=end  W4WK gửi job_success → W4WK → idle

Dashboard hiển thị:
  - Cột Samsung: status=OFFLINE, log step cuối là batch_device_error
  - Cột W4WK: "Chạy thay Samsung" card (orange) + log step từ t=41s
  - Session KHU C: kết quả đầy đủ từ cả Samsung + W4WK
```
