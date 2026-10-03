import { describe, expect, it } from "vitest";
import { MESSAGE_ID_BYTES, PEER_ID_BYTES, ROOM_ID_BYTES, SECRET_BYTES } from "./constants.js";
import { base64UrlToBytes } from "./base64.js";
import {
  generateLabel,
  generateMessageId,
  generatePeerId,
  generateRoomId,
  generateSecret,
  isValidMessageId,
  isValidRoomId,
  isValidSecret,
} from "./random.js";

describe("id generators", () => {
  it("generates a room id of 8 bytes / 11 chars", () => {
    const roomId = generateRoomId();
    expect(roomId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(base64UrlToBytes(roomId)).toHaveLength(ROOM_ID_BYTES);
    expect(isValidRoomId(roomId)).toBe(true);
  });

  it("generates a secret of 16 bytes / 22 chars", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(base64UrlToBytes(secret)).toHaveLength(SECRET_BYTES);
    expect(isValidSecret(secret)).toBe(true);
  });

  it("generates a peer id of 16 bytes and a message id of 8 bytes", () => {
    const peerId = generatePeerId();
    expect(base64UrlToBytes(peerId)).toHaveLength(PEER_ID_BYTES);
    expect(base64UrlToBytes(generateMessageId())).toHaveLength(MESSAGE_ID_BYTES);
    expect(isValidMessageId(generateMessageId())).toBe(true);
  });

  it("does not collide across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(generateRoomId());
    }
    expect(seen.size).toBe(500);
  });

  it("rejects invalid ids", () => {
    expect(isValidRoomId("")).toBe(false);
    expect(isValidRoomId("short")).toBe(false);
    expect(isValidRoomId("x".repeat(23))).toBe(false);
    expect(isValidRoomId("!".repeat(22))).toBe(false);
    expect(isValidRoomId(42)).toBe(false);
  });
});

describe("generateLabel", () => {
  it("produces 4-digit labels", () => {
    for (let i = 0; i < 100; i++) {
      expect(generateLabel()).toMatch(/^[0-9]{4}$/);
    }
  });

  it("avoids occupied labels", () => {
    const occupied = new Set<string>(["0000", "0001", "1234"]);
    for (let i = 0; i < 100; i++) {
      const label = generateLabel(occupied);
      expect(occupied.has(label)).toBe(false);
      expect(label).toMatch(/^[0-9]{4}$/);
    }
  });

  it("returns a free label when 9999 labels are taken", () => {
    const occupied = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      if (i === 4242) continue;
      occupied.add(String(i).padStart(4, "0"));
    }
    expect(generateLabel(occupied)).toBe("4242");
  });
});
