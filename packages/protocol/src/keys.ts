import { base64UrlToBytes, bytesToBase64Url } from "./base64.js";
import { AUTH_TOKEN_BYTES, HKDF_INFO_AUTH, HKDF_INFO_ENC, SECRET_BYTES } from "./constants.js";
import { ProtocolError } from "./errors.js";

const encoder = new TextEncoder();

export interface DerivedKeys {
  /** AES-256-GCM key used to encrypt/decrypt message payloads. */
  encKey: CryptoKey;
  /**
   * 32-byte base64url token sent to the server to prove link possession.
   * Derived with a different HKDF info string, so it reveals nothing about
   * the encryption key and cannot be used to decrypt anything.
   */
  authToken: string;
}

/**
 * HKDF-SHA256 from the 32-byte master secret.
 *  - info "aside-v1-enc"  -> 256-bit AES-GCM key
 *  - info "aside-v1-auth" -> 32-byte auth token
 * Empty salt per RFC 5869 default (treated as a zero-filled HashLen salt).
 */
export async function deriveKeys(secret: string): Promise<DerivedKeys> {
  let secretBytes: Uint8Array<ArrayBuffer>;
  try {
    secretBytes = base64UrlToBytes(secret);
  } catch {
    throw new ProtocolError("bad_secret");
  }
  if (secretBytes.length !== SECRET_BYTES) {
    throw new ProtocolError("bad_secret");
  }

  const baseKey = await crypto.subtle.importKey("raw", secretBytes, "HKDF", false, ["deriveBits"]);

  const encBits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: encoder.encode(HKDF_INFO_ENC),
      },
      baseKey,
      256,
    ),
  );
  const authBits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: encoder.encode(HKDF_INFO_AUTH),
      },
      baseKey,
      AUTH_TOKEN_BYTES * 8,
    ),
  );

  const encKey = await crypto.subtle.importKey("raw", encBits, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);

  return { encKey, authToken: bytesToBase64Url(authBits) };
}
