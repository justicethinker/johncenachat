import { isBase64UrlOfLength, base64UrlToBytes, bytesToBase64Url } from "./base64.js";
import {
  LABEL_LENGTH,
  MESSAGE_ID_BYTES,
  PEER_ID_BYTES,
  ROOM_ID_BYTES,
  SECRET_BYTES,
} from "./constants.js";
import { ProtocolError } from "./errors.js";

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** 16 random bytes, base64url (22 chars). */
export function generateRoomId(): string {
  return bytesToBase64Url(randomBytes(ROOM_ID_BYTES));
}

/** 32 random bytes, base64url (43 chars). Lives only in the URL fragment. */
export function generateSecret(): string {
  return bytesToBase64Url(randomBytes(SECRET_BYTES));
}

/** 16 random bytes, base64url. Generated in memory per tab, never persisted. */
export function generatePeerId(): string {
  return bytesToBase64Url(randomBytes(PEER_ID_BYTES));
}

/** 8 random bytes, base64url (11 chars). Identifies a message inside one room. */
export function generateMessageId(): string {
  return bytesToBase64Url(randomBytes(MESSAGE_ID_BYTES));
}

/**
 * A random 4-digit label (e.g. "0377"), distinct from `occupied`.
 * Uses rejection sampling so the distribution over 0000-9999 is uniform.
 */
export function generateLabel(occupied?: ReadonlySet<string>): string {
  const taken = occupied ?? new Set<string>();
  let label = "";
  for (let attempt = 0; attempt < 1000; attempt++) {
    const buf = randomBytes(2);
    const value = (buf[0]! << 8) | buf[1]!;
    if (value >= 60000) continue; // 60000 = 6 * 10000, keeps modulo unbiased
    label = String(value % 10000).padStart(LABEL_LENGTH, "0");
    if (!taken.has(label)) {
      return label;
    }
  }
  // Pathological fallback: scan for any free label.
  for (let i = 0; i < 10000; i++) {
    const candidate = String(i).padStart(LABEL_LENGTH, "0");
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  throw new ProtocolError("no_free_label");
}

export function isValidRoomId(input: unknown): input is string {
  return isBase64UrlOfLength(input, ROOM_ID_BYTES);
}

export function isValidSecret(input: unknown): input is string {
  return isBase64UrlOfLength(input, SECRET_BYTES);
}

export function isValidPeerId(input: unknown): input is string {
  return isBase64UrlOfLength(input, PEER_ID_BYTES);
}

export function isValidMessageId(input: unknown): input is string {
  return isBase64UrlOfLength(input, MESSAGE_ID_BYTES);
}

/** Decode a base64url string; throws ProtocolError("bad_base64") when malformed. */
export function decodeBase64Url(input: string): Uint8Array {
  return base64UrlToBytes(input);
}
