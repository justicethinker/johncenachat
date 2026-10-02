import { describe, expect, it } from "vitest";
import { base64UrlToBytes } from "./base64.js";
import { AUTH_TOKEN_BYTES, SECRET_BYTES } from "./constants.js";
import { encryptMessage, decryptMessage } from "./crypto.js";
import { ProtocolError } from "./errors.js";
import { deriveKeys } from "./keys.js";
import { generateMessageId, generateRoomId, generateSecret } from "./random.js";

describe("deriveKeys", () => {
  it("produces a non-extractable AES-GCM key and a 32-byte auth token", async () => {
    const { encKey, authToken } = await deriveKeys(generateSecret());
    expect(encKey.algorithm.name).toBe("AES-GCM");
    // The derived key can never be read back out as bytes by script.
    expect(encKey.extractable).toBe(false);
    expect(base64UrlToBytes(authToken)).toHaveLength(AUTH_TOKEN_BYTES);
    expect(authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("authToken reveals nothing about the encryption key material", async () => {
    const { encKey, authToken } = await deriveKeys(generateSecret());
    const roomId = generateRoomId();
    const wire = await encryptMessage({ id: generateMessageId(), text: "hi" }, encKey, roomId);

    // Using the auth token bytes as an AES key must not decrypt anything:
    // if the token equalled the key material, this would succeed.
    const authKey = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(authToken),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    await expect(decryptMessage(wire, authKey, roomId)).rejects.toThrow(ProtocolError);

    // And the derived key itself still works.
    const decrypted = await decryptMessage(wire, encKey, roomId);
    expect(decrypted.text).toBe("hi");
  });

  it("is deterministic for the same secret and distinct across secrets", async () => {
    const secret = generateSecret();
    const first = await deriveKeys(secret);
    const second = await deriveKeys(secret);
    expect(first.authToken).toBe(second.authToken);

    const roomId = generateRoomId();
    const payload = { id: generateMessageId(), text: "same key?" };
    const wire = await encryptMessage(payload, first.encKey, roomId);
    // Same derived key material: second derivation decrypts the first's message.
    expect(await decryptMessage(wire, second.encKey, roomId)).toEqual(payload);

    const other = await deriveKeys(generateSecret());
    expect(other.authToken).not.toBe(first.authToken);
    await expect(decryptMessage(wire, other.encKey, roomId)).rejects.toThrow(ProtocolError);
  });

  it("derives different key material for enc vs auth info strings", async () => {
    const { encKey, authToken } = await deriveKeys(generateSecret());
    const roomId = generateRoomId();
    const wire = await encryptMessage({ id: generateMessageId(), text: "hi" }, encKey, roomId);

    // If authToken bytes were the AES key, importing them would decrypt this message.
    const authKey = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(authToken),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    await expect(decryptMessage(wire, authKey, roomId)).rejects.toThrow(ProtocolError);
    expect(encKey.extractable).toBe(false);
  });

  it("rejects malformed secrets", async () => {
    await expect(deriveKeys("not-base64!")).rejects.toThrow(ProtocolError);
    await expect(deriveKeys("AA")).rejects.toThrow(ProtocolError);
    await expect(deriveKeys("")).rejects.toThrow(ProtocolError);
    expect(SECRET_BYTES).toBe(32);
  });
});
