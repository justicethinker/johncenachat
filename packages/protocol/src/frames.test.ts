import { describe, expect, it } from "vitest";
import { bytesToBase64Url } from "./base64.js";
import { MAX_FRAME_BYTES } from "./constants.js";
import { parseClientFrame, parseServerFrame } from "./frames.js";
import { generatePeerId } from "./random.js";

const AUTH = bytesToBase64Url(new Uint8Array(32).fill(7));
const CIPHER = bytesToBase64Url(new Uint8Array(64).fill(9));

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe("parseClientFrame", () => {
  it("accepts a valid join", () => {
    const peerId = generatePeerId();
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId }))).toEqual({
      type: "join",
      auth: AUTH,
      peerId,
    });
  });

  it("accepts a valid msg and leave", () => {
    expect(parseClientFrame(json({ type: "msg", n: 1, c: CIPHER }))).toEqual({
      type: "msg",
      n: 1,
      c: CIPHER,
    });
    expect(parseClientFrame(json({ type: "leave" }))).toEqual({ type: "leave" });
  });

  it("accepts n = 0", () => {
    expect(parseClientFrame(json({ type: "msg", n: 0, c: CIPHER }))).not.toBeNull();
  });

  it("rejects malformed joins", () => {
    expect(parseClientFrame(json({ type: "join", auth: AUTH }))).toBeNull(); // missing peerId
    expect(
      parseClientFrame(json({ type: "join", auth: "short", peerId: generatePeerId() })),
    ).toBeNull();
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId: "nope" }))).toBeNull();
    expect(
      parseClientFrame(json({ type: "join", auth: AUTH, peerId: generatePeerId(), extra: 1 })),
    ).toBeNull(); // smuggled field
  });

  it("rejects malformed msgs", () => {
    expect(parseClientFrame(json({ type: "msg", n: 1.5, c: CIPHER }))).toBeNull();
    expect(parseClientFrame(json({ type: "msg", n: -1, c: CIPHER }))).toBeNull();
    expect(parseClientFrame(json({ type: "msg", n: "1", c: CIPHER }))).toBeNull();
    expect(parseClientFrame(json({ type: "msg", n: 1 }))).toBeNull();
    expect(parseClientFrame(json({ type: "msg", n: 1, c: "" }))).toBeNull();
    expect(parseClientFrame(json({ type: "msg", n: 1, c: "not base64!" }))).toBeNull();
    expect(parseClientFrame(json({ type: "msg", n: 1, c: CIPHER, ts: 1 }))).toBeNull();
  });

  it("rejects unknown types, bad JSON and oversized frames", () => {
    expect(parseClientFrame(json({ type: "admin" }))).toBeNull();
    expect(parseClientFrame("{nope")).toBeNull();
    expect(parseClientFrame("")).toBeNull();
    expect(parseClientFrame("x".repeat(MAX_FRAME_BYTES + 1))).toBeNull();
    expect(parseClientFrame(json([1, 2, 3]))).toBeNull();
    expect(parseClientFrame(json("join"))).toBeNull();
  });
});

describe("parseServerFrame", () => {
  it("accepts joined with and without peerLabel", () => {
    expect(parseServerFrame(json({ type: "joined", label: "4821", peers: 1 }))).toEqual({
      type: "joined",
      label: "4821",
      peers: 1,
    });
    expect(
      parseServerFrame(json({ type: "joined", label: "4821", peerLabel: "0377", peers: 2 })),
    ).toEqual({ type: "joined", label: "4821", peerLabel: "0377", peers: 2 });
  });

  it("accepts peer, msg, ack, closed and err", () => {
    expect(parseServerFrame(json({ type: "peer", state: "joined", peerLabel: "0377" }))).toEqual({
      type: "peer",
      state: "joined",
      peerLabel: "0377",
    });
    expect(parseServerFrame(json({ type: "peer", state: "away" }))).toEqual({
      type: "peer",
      state: "away",
    });
    expect(parseServerFrame(json({ type: "msg", c: CIPHER }))).toEqual({ type: "msg", c: CIPHER });
    expect(parseServerFrame(json({ type: "ack", n: 3 }))).toEqual({ type: "ack", n: 3 });
    expect(parseServerFrame(json({ type: "closed", reason: "peer_left" }))).toEqual({
      type: "closed",
      reason: "peer_left",
    });
    expect(parseServerFrame(json({ type: "err", code: "room_full" }))).toEqual({
      type: "err",
      code: "room_full",
    });
  });

  it("rejects malformed labels, reasons and codes", () => {
    expect(parseServerFrame(json({ type: "joined", label: "482", peers: 1 }))).toBeNull();
    expect(parseServerFrame(json({ type: "joined", label: "48a1", peers: 1 }))).toBeNull();
    expect(parseServerFrame(json({ type: "joined", label: "4821", peers: 0 }))).toBeNull();
    expect(parseServerFrame(json({ type: "joined", label: "4821", peers: 3 }))).toBeNull();
    expect(parseServerFrame(json({ type: "peer", state: "gone" }))).toBeNull();
    expect(parseServerFrame(json({ type: "closed", reason: "because" }))).toBeNull();
    expect(parseServerFrame(json({ type: "err", code: "mystery" }))).toBeNull();
    expect(parseServerFrame(json({ type: "ack", n: 1, ts: 99 }))).toBeNull();
    expect(parseServerFrame("{nope")).toBeNull();
    expect(parseServerFrame(json({ type: "unknown" }))).toBeNull();
  });
});
