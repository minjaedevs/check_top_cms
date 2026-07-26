/**
 * SignalR JSON Protocol v1 helpers
 *
 * Frame format: JSON + \u001e (ASCII 30 record separator)
 * Handshake:    {"protocol":"json","version":1}\u001e
 * Message type 1 = invocation, type 6 = ping
 *
 * App sends TWO formats:
 *   Standard:     {"type":1,"target":"SubmitMobileResult","arguments":[...]}
 *   Non-standard: {"event":"register_pool","target":"register_pool","payload":{...}}
 */

export const RECORD_SEP = "\u001e";

export const HANDSHAKE_RESPONSE = `{}\u001e`;

// ─── Parse ────────────────────────────────────────────────────────────────────

export function parseFrames(raw: string): unknown[] {
  return raw
    .split(RECORD_SEP)
    .filter(Boolean)
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ─── Build ────────────────────────────────────────────────────────────────────

export function frame(obj: unknown): string {
  return JSON.stringify(obj) + RECORD_SEP;
}

/** SignalR type:1 invocation (no invocationId = fire-and-forget) */
export function invocation(target: string, ...args: unknown[]): string {
  return frame({ type: 1, target, arguments: args });
}

/** Convenience alias — same as invocation */
export const eventFrame = invocation;

export function pingFrame(): string {
  return frame({ type: 6 });
}

// ─── Classify incoming frame ─────────────────────────────────────────────────

export function isPing(msg: unknown): boolean {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).type === 6
  );
}

export function isHandshake(msg: unknown): boolean {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "protocol" in (msg as Record<string, unknown>)
  );
}

/**
 * Resolve the event name from either format:
 *   Standard:     msg.target  (e.g. "SubmitMobileResult")
 *   Non-standard: msg.event   (e.g. "register_pool")
 */
export function resolveEventName(msg: Record<string, unknown>): string | null {
  if (typeof msg.event === "string") return msg.event;
  if (typeof msg.target === "string") return msg.target;
  return null;
}

/**
 * Resolve the payload:
 *   Standard:     msg.arguments[0]  or msg.arguments
 *   Non-standard: msg.payload
 */
export function resolvePayload(msg: Record<string, unknown>): unknown {
  if (msg.payload !== undefined) return msg.payload;
  const args = msg.arguments;
  if (Array.isArray(args)) return args.length === 1 ? args[0] : args;
  return msg;
}

// ─── S→C helper: send_event (non-standard format used in some builds) ────────

export function sendEventFrame(
  event: string,
  target: string,
  payload: unknown
): string {
  return frame({ event, target, payload });
}
