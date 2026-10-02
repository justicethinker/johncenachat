import { base64UrlToBytes, bytesToBase64Url } from "./base64.js";
import { GCM_TAG_BYTES, IV_BYTES, LENGTH_PREFIX_BYTES } from "./constants.js";
import { ProtocolError } from "./errors.js";
import { pad, unpad } from "./padding.js";
import { assertPayload, parsePayload, type MessagePayload } from "./payload.js";

const encoder = new TextEncoder();

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Encrypt a payload: JSON -> UTF-8 -> pad to bucket -> AES-256-GCM
 * with a fresh random 12-byte IV and AAD = UTF-8 bytes of the roomId.
 * Wire format: iv || ciphertext+tag, base64url.
 */
export async function encryptMessage(
  payload: MessagePayload,
  encKey: CryptoKey,
  roomId: string,
): Promise<string> {
  assertPayload(payload);
  const plaintext = encoder.encode(JSON.stringify(payload));
  const padded = pad(plaintext);
  const iv = randomBytes(IV_BYTES);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(roomId),
        tagLength: 128,
      },
      encKey,
      padded,
    ),
  );
  const wire = new Uint8Array(iv.length + ciphertext.length);
  wire.set(iv, 0);
  wire.set(ciphertext, iv.length);
  return bytesToBase64Url(wire);
}

/** Decrypt and validate a received wire message. Throws ProtocolError on any failure. */
export async function decryptMessage(
  wire: string,
  encKey: CryptoKey,
  roomId: string,
): Promise<MessagePayload> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64UrlToBytes(wire);
  } catch {
    throw new ProtocolError("bad_wire");
  }
  // iv + tag + smallest bucket
  const minimum = IV_BYTES + GCM_TAG_BYTES + LENGTH_PREFIX_BYTES + 1;
  if (bytes.length < minimum) {
    throw new ProtocolError("bad_wire");
  }
  const iv = bytes.subarray(0, IV_BYTES);
  const ciphertext = bytes.subarray(IV_BYTES);

  let padded: Uint8Array<ArrayBuffer>;
  try {
    padded = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: encoder.encode(roomId),
          tagLength: 128,
        },
        encKey,
        ciphertext,
      ),
    );
  } catch {
    throw new ProtocolError("decrypt_failed");
  }

  let raw: Uint8Array;
  try {
    raw = unpad(padded);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("bad_padding");
  }

  const payload = parsePayload(raw);
  if (payload === null) {
    throw new ProtocolError("bad_payload");
  }
  return payload;
}
