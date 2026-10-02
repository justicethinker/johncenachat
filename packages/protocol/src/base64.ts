import { ProtocolError } from "./errors.js";

/**
 * base64url codec (RFC 4648 section 5, no padding).
 * Implemented by hand so it behaves identically in Node and browsers
 * (no platform-specific helpers).
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const CHAR_TO_INT: Record<string, number> = Object.create(null) as Record<string, number>;
for (let i = 0; i < ALPHABET.length; i++) {
  CHAR_TO_INT[ALPHABET[i]!] = i;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i;
    const b0 = bytes[i]!;
    const b1 = remaining > 1 ? bytes[i + 1]! : 0;
    const b2 = remaining > 2 ? bytes[i + 2]! : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += ALPHABET[(n >> 18) & 63];
    out += ALPHABET[(n >> 12) & 63];
    out += remaining > 1 ? ALPHABET[(n >> 6) & 63] : "=";
    out += remaining > 2 ? ALPHABET[n & 63] : "=";
  }
  return out.replace(/=+$/, "");
}

export function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  if (typeof input !== "string" || input.length % 4 === 1) {
    throw new ProtocolError("bad_base64");
  }
  const out = new Uint8Array(Math.floor((input.length * 6) / 8));
  let bitBuffer = 0;
  let bitCount = 0;
  let outIdx = 0;
  for (let i = 0; i < input.length; i++) {
    const value = CHAR_TO_INT[input[i]!];
    if (value === undefined) {
      throw new ProtocolError("bad_base64");
    }
    bitBuffer = (bitBuffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[outIdx++] = (bitBuffer >> bitCount) & 0xff;
    }
  }
  // Leftover bits must be zero, otherwise the encoding is non-canonical.
  if (bitCount > 0 && (bitBuffer & ((1 << bitCount) - 1)) !== 0) {
    throw new ProtocolError("bad_base64");
  }
  return out;
}

export function isBase64Url(input: unknown): input is string {
  if (typeof input !== "string" || input.length % 4 === 1) {
    return false;
  }
  try {
    base64UrlToBytes(input);
    return true;
  } catch {
    return false;
  }
}

/** base64url string that decodes to exactly `byteLength` bytes. */
export function isBase64UrlOfLength(input: unknown, byteLength: number): input is string {
  if (!isBase64Url(input)) {
    return false;
  }
  return base64UrlToBytes(input).length === byteLength;
}
