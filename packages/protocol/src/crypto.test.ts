import { beforeAll, describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url } from "./base64.js";
import { decryptMessage, encryptMessage } from "./crypto.js";
import { ProtocolError } from "./errors.js";
import { deriveKeys, type DerivedKeys } from "./keys.js";
import { generateMessageId, generateRoomId, generateSecret } from "./random.js";
import type { MessagePayload } from "./payload.js";

describe("encryptMessage / decryptMessage", () => {
  let keys: DerivedKeys;
  let roomId: string;

  beforeAll(async () => {
    keys = await deriveKeys(generateSecret());
    roomId = generateRoomId();
  });

  it("round trips a payload", async () => {
    const payload: MessagePayload = { id: generateMessageId(), text: "hello aside" };
    const wire = await encryptMessage(payload, keys.encKey, roomId);
    expect(wire).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decryptMessage(wire, keys.encKey, roomId)).toEqual(payload);
  });

  it("round trips a payload with a reply target", async () => {
    const payload: MessagePayload = {
      id: generateMessageId(),
      text: "replying",
      re: generateMessageId(),
    };
    const wire = await encryptMessage(payload, keys.encKey, roomId);
    expect(await decryptMessage(wire, keys.encKey, roomId)).toEqual(payload);
  });

  it("fails on tampered ciphertext", async () => {
    const wire = await encryptMessage(
      { id: generateMessageId(), text: "secret" },
      keys.encKey,
      roomId,
    );
    const bytes = base64UrlToBytes(wire);
    bytes[bytes.length - 1] ^= 0x01; // flip a bit in the tag
    const tampered = bytesToBase64Url(bytes);
    await expect(decryptMessage(tampered, keys.encKey, roomId)).rejects.toThrow(ProtocolError);
  });

  it("fails on tampered IV", async () => {
    const wire = await encryptMessage(
      { id: generateMessageId(), text: "secret" },
      keys.encKey,
      roomId,
    );
    const bytes = base64UrlToBytes(wire);
    bytes[0] ^= 0x01;
    await expect(decryptMessage(bytesToBase64Url(bytes), keys.encKey, roomId)).rejects.toThrow(
      ProtocolError,
    );
  });

  it("fails with the wrong key", async () => {
    const other = await deriveKeys(generateSecret());
    const wire = await encryptMessage(
      { id: generateMessageId(), text: "secret" },
      keys.encKey,
      roomId,
    );
    await expect(decryptMessage(wire, other.encKey, roomId)).rejects.toThrow(ProtocolError);
  });

  it("fails with the wrong roomId (AAD)", async () => {
    const wire = await encryptMessage(
      { id: generateMessageId(), text: "secret" },
      keys.encKey,
      roomId,
    );
    await expect(decryptMessage(wire, keys.encKey, generateRoomId())).rejects.toThrow(
      ProtocolError,
    );
  });

  it("produces different ciphertext for the same text (fresh IV)", async () => {
    const payload: MessagePayload = { id: generateMessageId(), text: "same text" };
    const a = await encryptMessage(payload, keys.encKey, roomId);
    const b = await encryptMessage(payload, keys.encKey, roomId);
    expect(a).not.toBe(b);
    expect(await decryptMessage(a, keys.encKey, roomId)).toEqual(payload);
    expect(await decryptMessage(b, keys.encKey, roomId)).toEqual(payload);
  });

  it("never leaks the plaintext into the wire format", async () => {
    const payload: MessagePayload = { id: generateMessageId(), text: "hunter2 plaintext" };
    const wire = await encryptMessage(payload, keys.encKey, roomId);
    const bytes = base64UrlToBytes(wire);
    const needle = new TextEncoder().encode("hunter2 plaintext");
    let found = false;
    outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (bytes[i + j] !== needle[j]) continue outer;
      }
      found = true;
      break;
    }
    expect(found).toBe(false);
    expect(wire).not.toContain("hunter2");
  });

  it("rejects payloads over the text limit", async () => {
    const payload: MessagePayload = { id: generateMessageId(), text: "a".repeat(1501) };
    await expect(encryptMessage(payload, keys.encKey, roomId)).rejects.toThrow(ProtocolError);
    expect("a".repeat(1500).length).toBe(1500);
  });

  it("rejects payload bytes that do not fit the largest bucket", async () => {
    // 1500 three-byte CJK characters = 4500 UTF-8 bytes: within the character
    // limit, over the 4096 bucket limit.
    const payload: MessagePayload = { id: generateMessageId(), text: "\u4E00".repeat(1500) };
    try {
      await encryptMessage(payload, keys.encKey, roomId);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("too_large");
    }
  });

  it("rejects malformed wire strings", async () => {
    await expect(decryptMessage("not base64!", keys.encKey, roomId)).rejects.toThrow(ProtocolError);
    await expect(decryptMessage("", keys.encKey, roomId)).rejects.toThrow(ProtocolError);
    await expect(decryptMessage("AAAA", keys.encKey, roomId)).rejects.toThrow(ProtocolError);
  });
});
