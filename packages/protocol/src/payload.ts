import { MAX_TEXT_LENGTH } from "./constants.js";
import { ProtocolError } from "./errors.js";
import { isValidMessageId } from "./random.js";

/**
 * Plaintext payload (spec section 5): id, text and optional reply target.
 * No timestamps, no names - ever.
 */
export interface MessagePayload {
  id: string;
  text: string;
  re?: string;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set(["id", "text", "re"]);

/** Validate an outbound payload. Throws ProtocolError on any violation. */
export function assertPayload(payload: unknown): asserts payload is MessagePayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ProtocolError("bad_payload");
  }
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    // Reject unknown keys so nothing (timestamps, names, metadata) can ride along.
    if (!ALLOWED_KEYS.has(key)) {
      throw new ProtocolError("bad_payload");
    }
  }
  if (!isValidMessageId(record.id)) {
    throw new ProtocolError("bad_payload");
  }
  if (typeof record.text !== "string" || record.text.length > MAX_TEXT_LENGTH) {
    throw new ProtocolError("bad_payload");
  }
  if (record.re !== undefined && !isValidMessageId(record.re)) {
    throw new ProtocolError("bad_payload");
  }
}

/** Parse and strictly validate an inbound plaintext payload. Returns null if malformed. */
export function parsePayload(bytes: Uint8Array): MessagePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  try {
    assertPayload(parsed);
  } catch {
    return null;
  }
  return parsed;
}
