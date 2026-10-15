import { describe, expect, it } from "vitest";
import { bytesToBase64Url } from "./base64.js";
import { MAX_PEERS, MAX_FRAME_BYTES } from "./constants.js";
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

  it("validates optional vanish as a boolean on join", () => {
    const peerId = generatePeerId();
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId, vanish: true }))).toEqual({
      type: "join",
      auth: AUTH,
      peerId,
      vanish: true,
    });
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId, vanish: false }))).toEqual({
      type: "join",
      auth: AUTH,
      peerId,
      vanish: false,
    });
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId, vanish: "yes" }))).toBeNull();
  });

  it("accepts a join with a valid cap", () => {
    const peerId = generatePeerId();
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId, cap: 4 }))).toEqual({
      type: "join",
      auth: AUTH,
      peerId,
      cap: 4,
    });
  });

  it("accepts a join with cap at the extremes", () => {
    const peerId = generatePeerId();
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId, cap: 2 }))).toEqual({
      type: "join",
      auth: AUTH,
      peerId,
      cap: 2,
    });
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId, cap: MAX_PEERS }))).toEqual({
      type: "join",
      auth: AUTH,
      peerId,
      cap: MAX_PEERS,
    });
  });

  it("accepts msg, lock, close and leave frames", () => {
    expect(parseClientFrame(json({ type: "msg", n: 1, c: CIPHER }))).toEqual({
      type: "msg",
      n: 1,
      c: CIPHER,
    });
    expect(parseClientFrame(json({ type: "lock" }))).toEqual({
      type: "lock",
    });
    expect(parseClientFrame(json({ type: "close" }))).toEqual({ type: "close" });
    expect(parseClientFrame(json({ type: "leave" }))).toEqual({ type: "leave" });
  });

  it("accepts n = 0", () => {
    expect(parseClientFrame(json({ type: "msg", n: 0, c: CIPHER }))).not.toBeNull();
  });

  it("rejects a client-provided from on join", () => {
    const peerId = generatePeerId();
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId, from: "4821" }))).toBeNull();
  });

  it("preserves numeric cap values for the manager to return bad_cap or ignore", () => {
    const peerId = generatePeerId();
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId, cap: 1 }))).toEqual({
      type: "join",
      auth: AUTH,
      peerId,
      cap: 1,
    });
    expect(
      parseClientFrame(json({ type: "join", auth: AUTH, peerId, cap: MAX_PEERS + 1 })),
    ).toEqual({ type: "join", auth: AUTH, peerId, cap: MAX_PEERS + 1 });
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId, cap: 3.5 }))).toEqual({
      type: "join",
      auth: AUTH,
      peerId,
      cap: 3.5,
    });
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId, cap: -2 }))).toEqual({
      type: "join",
      auth: AUTH,
      peerId,
      cap: -2,
    });
  });

  it("rejects non-numeric cap values", () => {
    const peerId = generatePeerId();
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId, cap: "4" }))).toBeNull();
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId, cap: null }))).toBeNull();
  });

  it("rejects a cap with a smuggled extra field", () => {
    const peerId = generatePeerId();
    expect(
      parseClientFrame(
        json({
          type: "join",
          auth: AUTH,
          peerId,
          cap: 4,
          extra: 1,
        }),
      ),
    ).toBeNull();
  });

  it("rejects malformed joins", () => {
    expect(parseClientFrame(json({ type: "join", auth: AUTH }))).toBeNull(); // missing peerId
    expect(
      parseClientFrame(json({ type: "join", auth: "short", peerId: generatePeerId() })),
    ).toBeNull();
    expect(parseClientFrame(json({ type: "join", auth: AUTH, peerId: "nope" }))).toBeNull();
    expect(
      parseClientFrame(
        json({
          type: "join",
          auth: AUTH,
          peerId: generatePeerId(),
          extra: 1,
        }),
      ),
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
  it("accepts joined with required group state and vanish setting", () => {
    expect(
      parseServerFrame(
        json({
          type: "joined",
          label: "4821",
          members: [],
          cap: 8,
          locked: false,
          isCreator: true,
          vanish: true,
        }),
      ),
    ).toEqual({
      type: "joined",
      label: "4821",
      members: [],
      cap: 8,
      locked: false,
      isCreator: true,
      vanish: true,
    });
  });

  it("accepts joined with members and vanish disabled", () => {
    expect(
      parseServerFrame(
        json({
          type: "joined",
          label: "4821",
          members: ["0377", "2201"],
          cap: 4,
          locked: true,
          isCreator: true,
          vanish: false,
        }),
      ),
    ).toEqual({
      type: "joined",
      label: "4821",
      members: ["0377", "2201"],
      cap: 4,
      locked: true,
      isCreator: true,
      vanish: false,
    });
  });

  it("rejects joined with a cap outside 2..MAX_PEERS", () => {
    const frame = {
      type: "joined",
      label: "4821",
      members: [],
      locked: false,
      isCreator: false,
      vanish: false,
    };
    expect(parseServerFrame(json({ ...frame, cap: 1 }))).toBeNull();
    expect(parseServerFrame(json({ ...frame, cap: MAX_PEERS + 1 }))).toBeNull();
  });

  it("accepts peer with count", () => {
    expect(
      parseServerFrame(json({ type: "peer", state: "joined", label: "0377", count: 3 })),
    ).toEqual({
      type: "peer",
      state: "joined",
      label: "0377",
      count: 3,
    });
    expect(
      parseServerFrame(json({ type: "peer", state: "away", label: "0377", count: 1 })),
    ).toEqual({ type: "peer", state: "away", label: "0377", count: 1 });
  });

  it("accepts msg with a server-stamped from label", () => {
    expect(parseServerFrame(json({ type: "msg", from: "4821", c: CIPHER }))).toEqual({
      type: "msg",
      from: "4821",
      c: CIPHER,
    });
  });

  it("rejects msg without from", () => {
    expect(parseServerFrame(json({ type: "msg", c: CIPHER }))).toBeNull();
  });

  it("rejects msg with a bad from label", () => {
    expect(parseServerFrame(json({ type: "msg", from: "48a1", c: CIPHER }))).toBeNull();
    expect(parseServerFrame(json({ type: "msg", from: "482", c: CIPHER }))).toBeNull();
  });

  it("accepts ack, locked, all close reasons and group error codes", () => {
    expect(parseServerFrame(json({ type: "ack", n: 3 }))).toEqual({ type: "ack", n: 3 });
    expect(parseServerFrame(json({ type: "locked" }))).toEqual({
      type: "locked",
    });
    expect(parseServerFrame(json({ type: "closed", reason: "peer_left" }))).toEqual({
      type: "closed",
      reason: "peer_left",
    });
    expect(parseServerFrame(json({ type: "closed", reason: "creator_left" }))).toEqual({
      type: "closed",
      reason: "creator_left",
    });
    expect(parseServerFrame(json({ type: "closed", reason: "closed_by_creator" }))).toEqual({
      type: "closed",
      reason: "closed_by_creator",
    });
    expect(parseServerFrame(json({ type: "err", code: "room_full" }))).toEqual({
      type: "err",
      code: "room_full",
    });
    expect(parseServerFrame(json({ type: "err", code: "room_locked" }))).toEqual({
      type: "err",
      code: "room_locked",
    });
    expect(parseServerFrame(json({ type: "err", code: "bad_cap" }))).toEqual({
      type: "err",
      code: "bad_cap",
    });
    expect(parseServerFrame(json({ type: "err", code: "not_creator" }))).toEqual({
      type: "err",
      code: "not_creator",
    });
  });

  it("rejects malformed labels, reasons, fields and codes", () => {
    const validJoined = {
      type: "joined",
      label: "4821",
      members: [],
      cap: 2,
      locked: false,
      isCreator: false,
      vanish: false,
    };
    expect(parseServerFrame(json({ ...validJoined, label: "482" }))).toBeNull();
    expect(parseServerFrame(json({ ...validJoined, label: "48a1" }))).toBeNull();
    expect(parseServerFrame(json({ ...validJoined, extra: true }))).toBeNull();
    expect(
      parseServerFrame(json({ type: "peer", state: "gone", label: "0377", count: 1 })),
    ).toBeNull();
    expect(parseServerFrame(json({ type: "peer", state: "joined", label: "0377" }))).toBeNull();
    expect(parseServerFrame(json({ type: "closed", reason: "because" }))).toBeNull();
    expect(parseServerFrame(json({ type: "closed", reason: "creator_left", extra: 1 }))).toBeNull();
    expect(parseServerFrame(json({ type: "err", code: "mystery" }))).toBeNull();
    expect(parseServerFrame(json({ type: "ack", n: 1, ts: 99 }))).toBeNull();
    expect(parseServerFrame("{nope")).toBeNull();
    expect(parseServerFrame(json({ type: "unknown" }))).toBeNull();
  });

  it("rejects joined with a non-boolean vanish flag", () => {
    const joined = {
      type: "joined",
      label: "4821",
      members: [],
      cap: 2,
      locked: false,
      isCreator: false,
      vanish: "yes",
    };
    expect(parseServerFrame(json(joined))).toBeNull();
  });

  it("rejects peer with count above MAX_PEERS", () => {
    expect(
      parseServerFrame(
        json({ type: "peer", state: "joined", label: "0377", count: MAX_PEERS + 1 }),
      ),
    ).toBeNull();
  });

  it("rejects joined with bad members", () => {
    expect(
      parseServerFrame(
        json({
          type: "joined",
          label: "4821",
          members: ["4821", "bad"],
          cap: 2,
          locked: false,
          isCreator: false,
          vanish: false,
        }),
      ),
    ).toBeNull();
    expect(
      parseServerFrame(
        json({
          type: "joined",
          label: "4821",
          members: "not-array",
          cap: 2,
          locked: false,
          isCreator: false,
          vanish: false,
        }),
      ),
    ).toBeNull();
  });

  it("accepts false for the joined locked flag and rejects wrong types", () => {
    expect(
      parseServerFrame(
        json({
          type: "joined",
          label: "4821",
          members: [],
          cap: 2,
          locked: false,
          isCreator: false,
          vanish: false,
        }),
      ),
    ).not.toBeNull();
    expect(
      parseServerFrame(
        json({
          type: "joined",
          label: "4821",
          members: [],
          cap: 2,
          locked: 1,
          isCreator: false,
          vanish: false,
        }),
      ),
    ).toBeNull();
    expect(
      parseServerFrame(
        json({
          type: "joined",
          label: "4821",
          members: [],
          cap: 2,
          locked: true,
          isCreator: 1,
          vanish: false,
        }),
      ),
    ).toBeNull();
  });
});
