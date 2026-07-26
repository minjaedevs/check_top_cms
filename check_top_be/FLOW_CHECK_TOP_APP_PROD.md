# check_top_be — Tài liệu luồng chạy & WebSocket Events

> **Cập nhật:** 2026-07-26
> **Runtime:** Bun + Hono
> **File chính:** `src/handlers/app-ws.ts` · `src/store.ts` · `src/protocol.ts` · `src/types.ts`

---

## Mục lục

1. [Kiến trúc tổng quan](#1-kiến-trúc-tổng-quan)
2. [Giao thức SignalR JSON v1](#2-giao-thức-signalr-json-v1)
3. [Events C→S (App → Server)](#3-events-cs-app--server)
4. [Events S→C (Server → App)](#4-events-sc-server--app) — RetryBatch · BatchReassignFallback · QueryEligibleDevice · ForceReassignDevice · poll_device_status
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
| `pendingQueries` | `Map<queryId, PendingQuery>` — collector cho QueryEligibleDevice round-trip (3s) |

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
- `REASSIGNED`: App tự tìm được thiết bị thay thế trong cùng pool (DK1/2/3 pass), **hoặc** sau khi nhận `ForceReassignDevice` từ server
- `NO_ELIGIBLE_DEVICE`: App không tìm được thiết bị nào (DK1/2/3 fail hết), nhờ server xử lý

**Format — Case REASSIGNED:**

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

**Format — Case NO_ELIGIBLE_DEVICE:**

```json
{
  "event": "BatchDeviceError",
  "payload": {
    "deviceId": "emulator-5554",
    "sessionId": "sess-uuid-001",
    "batchId": "batch-001",
    "status": "NO_ELIGIBLE_DEVICE",
    "currentDeptId": "dept-001",
    "remainingItems": [
      {
        "requestId": "keyword|vn|proxy|uuid|dept-001|KHU%20A",
        "keyword": "mua bán nhà",
        "proxy": ["proxy-01"],
        "country": 1,
        "departmentId": "dept-001",
        "departmentName": "KHU A",
        "deviceId": null
      }
    ],
    "allKhus": [
      {
        "departmentId": "dept-001",
        "departmentName": "KHU A",
        "items": [ /* tất cả KhuItem của khu này, kể cả đã hoàn thành */ ]
      },
      {
        "departmentId": "dept-002",
        "departmentName": "KHU B",
        "items": [ /* tất cả KhuItem của khu pending */ ]
      }
    ]
  }
}
```

| Field | Mô tả |
|---|---|
| `currentDeptId` | departmentId của khu đang chạy dở |
| `remainingItems` | Các keyword chưa chạy của **khu đang chạy** — dùng cho ForceReassignDevice (cùng PC) |
| `allKhus` | **Toàn bộ** tất cả khu (current + pending), mỗi khu chứa full items — dùng cho cross-PC CheckKeywords |

> **Tại sao phân biệt `remainingItems` vs `allKhus`?**
> - Cùng PC (`ForceReassignDevice`): chỉ cần `remainingItems` của khu đang chạy dở. Các khu pending vẫn còn trong queue nội bộ của app.
> - Khác PC (`CheckKeywords` cross-PC): cần `allKhus` FULL vì PC khác không có queue của PC này — phải chạy lại từ đầu.

**Server xử lý:**
- Cancel safety watchdog (`recoveryMap`)
- Push log `batch_device_error`

**Case `REASSIGNED`:**
1. Mark device gốc → `offline`
2. Mark device mới → `processing` với `jobId/batchId` gốc
3. Push log `takeover_reassigned` cho device mới

**Case `NO_ELIGIBLE_DEVICE` (xem chi tiết ở mục 8):**
1. Mark device gốc → `offline` ngay lập tức
2. Push log `th2b_no_eligible_device`
3. Broadcast `QueryEligibleDevice` đến **tất cả** các client khác (trừ client báo lỗi)
4. Thu thập `EligibleDeviceResponse` trong 3 giây
5. Xử lý theo TH-A / TH-B1 / TH-B2 / Priority 3

---

### 3.11 `EligibleDeviceResponse`

**Khi nào:** Client trả lời sau khi nhận `QueryEligibleDevice` từ server.
Client chạy DK1/2/3 trên tất cả thiết bị mình quản lý và báo kết quả.
**Format:** Non-standard.

```json
{
  "event": "EligibleDeviceResponse",
  "payload": {
    "queryId": "q_1700000000000_abc12",
    "eligible": true,
    "deviceId": "emulator-5556"
  }
}
```

| Field | Mô tả |
|---|---|
| `queryId` | Echo lại queryId từ `QueryEligibleDevice` |
| `eligible` | `true` nếu có ít nhất 1 device pass DK1/2/3 |
| `deviceId` | Serial của device eligible (nếu `eligible=true`) |

**Logic DK1/2/3 tại client:**

| Điều kiện | Công thức |
|---|---|
| **DK1** | `done_by_B >= floor(total_khu_B / 2)` AND không có khu khác đang chờ |
| **DK2** | `total_khu_B <= 5` AND không có khu khác đang chờ |
| **DK3** | `remaining_A <= 5` AND không có khu khác đang chờ |

- `done_by_B` = số keyword device B đã hoàn thành thành công từ **khu hiện tại của B**
- `total_khu_B` = tổng số keyword trong khu hiện tại của B
- `remaining_A` = số keyword còn lại của device A bị fail (từ `remainingCount` trong QueryEligibleDevice)
- Device idle → **luôn eligible** (total=0, done=0, không khu nào chờ)

**Server xử lý:**
- Tìm `pendingQuery` theo `queryId`
- Thêm response vào danh sách
- Nếu nhận được response `eligible=true` **HOẶC** tất cả client đã trả lời → fire `processQueryResult` ngay (không chờ timeout)

---

### 3.12 `device_fail_recovery_cancel`

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

**Khi nào:** Watchdog timeout (device 3 phút hoặc recovery 60s) — server dispatch job cho thiết bị thay thế.
Gửi đến WS của pool chứa thiết bị thay thế (có thể là pool khác).

> **Lưu ý:** Event này chỉ còn dùng trong **watchdog path** (`fireDeviceTimeout`, `fireRecoveryFallback`).
> Luồng TH2b chủ động từ app dùng `QueryEligibleDevice` / `ForceReassignDevice` / `CheckKeywords` mới.

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

### 4.3 `QueryEligibleDevice`

**Khi nào:** Server nhận `BatchDeviceError(NO_ELIGIBLE_DEVICE)` từ một client — broadcast đến **tất cả các client khác** để hỏi xem client nào có device đủ điều kiện.

```json
{
  "event": "QueryEligibleDevice",
  "target": "QueryEligibleDevice",
  "payload": {
    "queryId": "q_1700000000000_abc12",
    "departmentId": "dept-001",
    "remainingCount": 7,
    "sessionId": "sess-uuid-001"
  }
}
```

| Field | Mô tả |
|---|---|
| `queryId` | UUID cho round-trip này — phải echo lại trong `EligibleDeviceResponse` |
| `departmentId` | DepartmentId của khu cần xử lý |
| `remainingCount` | Số keyword còn lại (`remaining_A` dùng cho DK3) |
| `sessionId` | Lab session đang bị fail |

**App nhận:** Chạy DK1/2/3 trên tất cả device đang quản lý → gửi `EligibleDeviceResponse` về server.

**Server timeout:** 3 giây (`QUERY_TIMEOUT_MS`). Sau 3s chưa đủ response → `processQueryResult` với những gì đã nhận.

---

### 4.4 `ForceReassignDevice`

**Khi nào:** TH-B1 — không client nào có device eligible (DK1/2/3 fail hết), nhưng pool gốc (pool của device bị fail) **vẫn còn device khác không offline**. Server yêu cầu client đó bắt buộc chọn device bất kỳ (bỏ qua DK).

```json
{
  "event": "ForceReassignDevice",
  "target": "ForceReassignDevice",
  "payload": {
    "queryId": "force_1700000000000",
    "originalDeviceId": "emulator-5554",
    "departmentId": "dept-001",
    "departmentName": "KHU A",
    "sessionId": "sess-uuid-001",
    "batchId": "batch-001",
    "remainingItems": [
      {
        "requestId": "keyword|vn|proxy|uuid|dept-001|KHU%20A",
        "keyword": "mua bán nhà",
        "proxy": ["proxy-01"],
        "country": 1,
        "departmentId": "dept-001",
        "departmentName": "KHU A",
        "deviceId": null
      }
    ]
  }
}
```

| Field | Mô tả |
|---|---|
| `queryId` | ID cho lần force này |
| `originalDeviceId` | Device bị fail (cần reassign job của device này) |
| `remainingItems` | **Chỉ** các keyword chưa chạy của khu đang dở — KHÔNG bao gồm khu pending (còn trong queue nội bộ của app) |
| `departmentId` / `departmentName` | Khu đang dở |

**App nhận:**
1. Chọn device đầu tiên available (không phải `originalDeviceId`, không offline) — bỏ qua DK
2. Reassign các queued job của `originalDeviceId` cho device đó
3. Gửi `BatchDeviceError(REASSIGNED, deviceId_new=<force_serial>)` về server để server log + update state

---

### 4.5 `poll_device_status`

**Khi nào:** Server chủ động hỏi app để lấy trạng thái mới nhất của tất cả device.
Gửi mỗi **30 giây** kể từ khi app kết nối (`DEVICE_POLL_INTERVAL_MS = 30_000`).
Mục đích: giữ FE dashboard đồng bộ ngay cả khi không có job nào đang chạy (app có thể miss ADB transition).

```json
{
  "event": "poll_device_status",
  "target": "poll_device_status",
  "payload": {
    "requestedAt": 1700000000000
  }
}
```

**App nhận:** Gửi lại `device_status` event cho từng device đang quản lý.
Mỗi `device_status` chạy qua `onDeviceStatus` handler bình thường → store → FE broadcast.

> **Lưu ý:** Đây là **server-initiated** poll, không phải response của một request cụ thể.
> App gửi nhiều `device_status` event riêng lẻ (1 per device), không có response frame chung.

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

### 8.1 DK1/2/3 — Điều kiện eligibility tại client

Khi device A fail, app scan tất cả device còn lại trong pool và kiểm tra từng device B:

| Điều kiện | Công thức | Ý nghĩa |
|---|---|---|
| **DK1** | `done_by_B >= floor(total_khu_B / 2)` AND `not other_khu_waiting` | B đã chạy xong hơn nửa khu → có thể nhận thêm |
| **DK2** | `total_khu_B <= 5` AND `not other_khu_waiting` | Khu của B nhỏ → có thể nhận thêm |
| **DK3** | `remaining_A <= 5` AND `not other_khu_waiting` | Số keyword A còn lại ít → không tốn nhiều B |

- `done_by_B` = số keyword B đã **DONE** từ **khu hiện tại của B** (không phải khu của A)
- `total_khu_B` = tổng keyword trong khu B đang chạy
- `remaining_A` = số keyword A còn trong queue (chưa chạy)
- `other_khu_waiting` = B còn khu khác đang chờ trong queue (có > 1 dept_id khác nhau)
- Device **idle** (total=0) → **luôn eligible**

Lấy device đầu tiên pass DK1 OR DK2 OR DK3.

---

### 8.2 Luồng TH1 — App tìm được device (REASSIGNED nội bộ)

```
App (PC1)                    Server                       Dashboard
 │                              │                              │
 │  [Device A bị rút]           │                              │
 │──device_fail_recovery_start─►│                              │
 │   (windowMs=30000)           │──step_log (device_fail_recovery_start)►│
 │                              │  [Start safety watchdog 60s]
 │
 │  [App thử kết nối lại 30s]
 │  [DK1/2/3: tìm được device B đủ điều kiện]
 │  [Giao remainingItems của A cho B]
 │
 │──BatchDeviceError───────────►│
 │   status=REASSIGNED          │  [Cancel safety watchdog]
 │   deviceId_new=emulator-5556 │──step_log (batch_device_error)──────►│
 │                              │──device_update (A → offline)────────►│
 │                              │──device_update (B → processing)─────►│
 │                              │──step_log (takeover_reassigned B)───►│
 │
 │  [B tiếp tục chạy job của A]
 │──step_change (deviceId=B)───►│
 │──SubmitMobileResult─────────►│
 │──job_success────────────────►│
```

---

### 8.3 Luồng TH2 — App không tìm được device (NO_ELIGIBLE_DEVICE)

```
App (PC1)                    Server                       App (PC2, PC3, ...)    Dashboard
 │                              │                              │                     │
 │──BatchDeviceError───────────►│                              │                     │
 │   status=NO_ELIGIBLE_DEVICE  │  [Cancel safety watchdog]   │                     │
 │   remainingItems=[...]       │──device_update (A → offline)────────────────────►│
 │   allKhus=[...]              │──step_log (th2b_no_eligible_device)─────────────►│
 │                              │                              │                     │
 │                              │──QueryEligibleDevice────────►│                     │
 │                              │   queryId, remainingCount    │  [DK1/2/3 scan]     │
 │                              │◄─EligibleDeviceResponse──────│                     │
 │                              │   eligible=true, deviceId=X  │                     │
 │                              │  (hoặc false nếu không có)   │                     │
 │                              │                              │                     │
 │                     [processQueryResult sau 3s timeout hoặc khi có đủ response]  │
```

**TH-A — Có eligible client (DK pass):**
```
Server                       App (PC2 — eligible)         Dashboard
 │                              │                              │
 │──CheckKeywords──────────────►│                              │
 │   allKhus FULL               │──step_log (th2b_cross_pool_eligible PC2)►│
 │  (PC1: step_log th2b_routed_cross_pool)                    │
 │                              │  [PC2 chạy toàn bộ các khu]
```

**TH-B1 — Không eligible, pool gốc (PC1) còn device khác:**
```
Server                       App (PC1)                    Dashboard
 │                              │                              │
 │──ForceReassignDevice────────►│                              │
 │   remainingItems của khu dở  │  [Chọn device bất kỳ]       │
 │──step_log (th2b_force_reassign)───────────────────────────►│
 │                              │──BatchDeviceError (REASSIGNED)►│
 │                              │  [device_update, takeover]   │
```

**TH-B2 — Pool gốc (PC1) không còn device nào, nhưng pool khác có:**
```
Server                       App (PC2 — first pool with devices)  Dashboard
 │                              │                                    │
 │──CheckKeywords──────────────►│                                    │
 │   allKhus FULL               │──step_log (th2b_cross_pool_force PC2)►│
 │  (PC1: step_log th2b_routed_cross_pool_force)                    │
 │                              │  [PC2 chạy toàn bộ các khu]
```

**Priority 3 — Không có device nào toàn hệ thống:**
```
Server                       Dashboard
 │                              │
 │──step_log (no_device_globally ALERT)────────────────────────►│
```

---

### 8.4 Luồng Safety watchdog timeout (App crash / hang)

```
[60 giây trôi qua sau device_fail_recovery_start, không nhận được BatchDeviceError]

Server                       Dashboard
 │                              │
 │  [fireRecoveryFallback()]    │
 │──step_log (recovery_watchdog_timeout)►│
 │  [Tìm replacement — ưu tiên idle pool khác → force cùng pool]
 │──device_update (original → offline)──►│
 │──device_update (fallback → processing)►│
 │──step_log (takeover_reassigned)──────►│
 │◄─BatchReassignFallback (gửi đến app của pool có fallback)
```

---

### 8.5 Tóm tắt routing NO_ELIGIBLE_DEVICE

```
BatchDeviceError(NO_ELIGIBLE_DEVICE)
        │
        ▼
Mark device gốc → offline
        │
        ▼
QueryEligibleDevice → tất cả client khác (3s timeout)
        │
        ├─ eligible response nhận được?
        │      YES → TH-A: CheckKeywords(allKhus FULL) → eligible client
        │
        └─ NO eligible:
               │
               ├─ Pool gốc còn device khác?
               │      YES → TH-B1: ForceReassignDevice(remainingItems) → pool gốc
               │             App chọn device bất kỳ, gửi REASSIGNED lại
               │
               └─ Pool gốc trống:
                      │
                      ├─ Pool khác còn device?
                      │      YES → TH-B2: CheckKeywords(allKhus FULL) → pool đó
                      │
                      └─ Không ai → ALERT: no_device_globally
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

> **Quan trọng:** `fireRecoveryFallback` dùng luồng **cũ** (BatchReassignFallback trực tiếp), KHÔNG dùng QueryEligibleDevice mới. Lý do: đây là trường hợp app crash/hang — không thể tin tưởng app sẽ xử lý QueryEligibleDevice → EligibleDeviceResponse.

1. Push log `recovery_watchdog_timeout`
2. Tìm idle device ở pool **khác** (`store.findIdleDeviceExcept(cid)`)
   - Nếu có → gửi `BatchReassignFallback(reason="recovery_watchdog")` đến WS của pool đó
   - Mark device gốc → `offline`, mark replacement → `processing`
   - Push log `recovery_watchdog_reassigned` + `takeover_reassigned`
3. Nếu không có pool khác → tìm device non-offline **cùng pool** (force)
   - Gửi `BatchReassignFallback(force=true, reason="recovery_watchdog")` về pool gốc
   - Mark device gốc → `offline`, mark replacement → `processing`
   - Push log `recovery_watchdog_force_fallback` + `takeover_reassigned`
4. Không có device nào → Push alert `no_device_globally`

---

### 9.3 QueryEligibleDevice Timeout (3 giây)

**Key:** `queryId` trong `pendingQueries`
**Timeout:** 3,000ms (`QUERY_TIMEOUT_MS`)
**Start khi:** Server broadcast `QueryEligibleDevice`
**Cancel khi:** Nhận đủ responses hoặc có response `eligible=true`

**Khi timeout:** Gọi `processQueryResult` với những response đã nhận (có thể ít hơn số client được query).

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
| `device_fail_recovery_start` | `running` | `onDeviceFailRecoveryStart` | App báo bắt đầu recovery window |
| `batch_device_error` | `failed` | `onBatchDeviceError` | App báo TH2b với status |
| `takeover_reassigned` | `running` | `onBatchDeviceError(REASSIGNED)` | Device B đang chạy thay cho device A |
| `th2b_no_eligible_device` | `failed` | `onBatchDeviceError(NO_ELIGIBLE_DEVICE)` | Client không tìm được device — server xử lý |
| `th2b_cross_pool_eligible` | `running` | `processQueryResult` TH-A | Server gửi CheckKeywords đến client eligible (DK pass) — log gắn vào **cid nhận** |
| `th2b_routed_cross_pool` | `running` | `processQueryResult` TH-A | Keywords đã route sang pool khác — log gắn vào **cid gốc** |
| `th2b_force_reassign` | `running` | `processQueryResult` TH-B1 | Server gửi ForceReassignDevice về cùng pool |
| `th2b_cross_pool_force` | `running` | `processQueryResult` TH-B2 | Server gửi CheckKeywords đến pool khác (pool gốc hết device) — log gắn vào **cid nhận** |
| `th2b_routed_cross_pool_force` | `running` | `processQueryResult` TH-B2 | Keywords đã route sang pool khác (B2) — log gắn vào **cid gốc** |
| `no_device_globally` | `failed` | `processQueryResult` / `fireRecoveryFallback` | ALERT — không có device nào toàn hệ thống |
| `recovery_watchdog_timeout` | `failed` | `fireRecoveryFallback` | Watchdog hết hạn, app không gửi BatchDeviceError |
| `recovery_watchdog_reassigned` | `running` | `fireRecoveryFallback` (found) | Watchdog tìm được device cross-pool |
| `recovery_watchdog_force_fallback` | `running` | `fireRecoveryFallback` (anyActive) | Watchdog force fallback cùng pool |
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

// Module-level trong app-ws.ts (không phải trong Store)
pendingQueries: Map<queryId, PendingQuery>   // TH2b QueryEligibleDevice collector

takeoverMap: Map<"origCid:origDeviceId", { newCid, newDeviceId }>
// Khi device B thay thế A, các event sau đó (step_change, SubmitMobileResult,
// job_success/failed) vẫn đến với deviceId=A.
// takeoverMap redirect chúng về device B để FE hiển thị log đúng cột.
// Set khi: onBatchDeviceError(REASSIGNED), fireDeviceTimeout, fireRecoveryFallback
// Clear khi: onJobSuccess, onJobFailed (delete entry gốc), clearTakeoverForCid (khi WS đóng)

PendingQuery {
  cid:            string            // connectionId của client báo NO_ELIGIBLE_DEVICE
  ws:             WSContext         // ws của client đó (dùng cho ForceReassignDevice)
  deviceId:       string            // device bị fail
  sessionId:      string | null
  batchId:        string | null
  currentDeptId:  string
  remainingItems: KhuItem[]         // partial current khu (cho ForceReassignDevice)
  allKhus:        KhuData[]         // full tất cả khu (cho cross-PC CheckKeywords)
  expectedCount:  number            // số client đã được gửi QueryEligibleDevice
  responses:      Array<{ connectionId, eligible, deviceId? }>
  timer:          Timer             // 3s timeout handle
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

## Phụ lục A — Ví dụ flow đầy đủ TH2b REASSIGNED (nội bộ)

```
Timeline (1 PC, 2 devices):
  t=0s   Samsung chạy job KHU C (10 keyword), step_change liên tục
  t=30s  Samsung bị rút dây USB
  t=30s  App phát hiện ADB disconnect → gửi device_fail_recovery_start
  t=30s  Server start safety watchdog 60s
  t=35s  App thử kết nối lại Samsung → thất bại
  t=40s  App scan DK1/2/3:
           W4WK đang chạy KHU D (total=8, done=5, floor=4, done>=floor → DK1 pass)
           Không có khu khác chờ → DK1 ELIGIBLE
  t=40s  App giao remainingItems KHU C cho W4WK
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

---

## Phụ lục B — Ví dụ flow TH2b NO_ELIGIBLE_DEVICE → TH-A (cross-PC)

```
Timeline (2 PC, mỗi PC 1 device, cả 2 đang bận):
  t=0s   PC1/SamsungA chạy KHU C (10 kw), PC2/SamsungB chạy KHU D (3 kw)
  t=30s  PC1/SamsungA bị rút dây
  t=30s  PC1 gửi device_fail_recovery_start
  t=30s  Server start safety watchdog 60s
  t=35s  PC1 thử kết nối lại → thất bại
  t=40s  PC1 scan DK1/2/3 (chỉ SamsungA trong pool — SamsungA là device fail → skip):
           Không có device nào khác → NO_ELIGIBLE_DEVICE
  t=40s  PC1 gửi BatchDeviceError {
           status: NO_ELIGIBLE_DEVICE,
           remainingItems: [7 keyword KHU C còn lại],
           allKhus: [{ dept=KHU_C, items: all 10 keyword }]
         }
  t=40s  Server:
           - Cancel safety watchdog
           - Mark SamsungA → offline
           - Push th2b_no_eligible_device
           - Broadcast QueryEligibleDevice(remainingCount=7) → PC2
  t=40s  PC2 nhận QueryEligibleDevice:
           SamsungB đang chạy KHU D, total=3 → DK2 pass (total<=5)
           Gửi EligibleDeviceResponse { eligible: true, deviceId: SamsungB }
  t=40s  Server nhận eligible → processQueryResult TH-A ngay lập tức:
           - Gửi CheckKeywords(allKhus=[KHU_C 10 keyword]) → PC2 device SamsungB
           - Push th2b_cross_pool_eligible (cid=PC2, device=SamsungB)
           - Push th2b_routed_cross_pool (cid=PC1, device=SamsungA)
  t=41s+ PC2/SamsungB chạy toàn bộ KHU C (từ đầu, vì khác PC)
  t=end  PC2 gửi job_success → SamsungB → idle

Lưu ý: PC2 chạy lại toàn bộ KHU C từ keyword đầu tiên, không phải từ keyword 8
(vì khác PC, không có queue state của PC1)
```

---

## Phụ lục C — Ví dụ flow TH2b NO_ELIGIBLE_DEVICE → TH-B1 (ForceReassignDevice)

```
Timeline (1 PC, 2 devices đều bận, cả 2 DK fail):
  t=0s   SamsungA chạy KHU C (10 kw), SamsungB chạy KHU D (10 kw) + KHU E pending
  t=30s  SamsungA bị rút → NO_ELIGIBLE_DEVICE
         (SamsungB: total=10, done=3, floor=5 → DK1 fail; total=10 → DK2 fail;
                    remaining_A=7 → DK3 fail; other_khu_waiting=true vì có KHU E → fail)
  t=40s  Server nhận NO_ELIGIBLE_DEVICE:
           - QueryEligibleDevice → không có client nào khác (chỉ 1 PC)
           - Hoặc PC2 không có device eligible
           - processQueryResult TH-B1: pool gốc còn SamsungB (non-offline)
           - Gửi ForceReassignDevice(remainingItems=[7 keyword KHU C]) → PC1
  t=40s  PC1 nhận ForceReassignDevice:
           - Chọn SamsungB (device đầu tiên không phải SamsungA, không offline)
           - Giao 7 keyword KHU C cho SamsungB (queue nội bộ)
           - Gửi BatchDeviceError { status: REASSIGNED, deviceId_new: SamsungB }
  t=40s  Server: Mark SamsungA → offline, SamsungB → processing, push takeover_reassigned

SamsungB tiếp tục:  KHU D đang dở → xong → KHU E pending → xong → 7 keyword KHU C → xong
```
