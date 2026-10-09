import {
  CREATOR_GRACE_MS,
  IDLE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_PEERS,
  MAX_ROOM_AGE_MS,
  MSG_RATE_BURST,
  RECONNECT_GRACE_MS,
  ROOM_CREATE_LIMIT_PER_IP,
  ROOM_CREATE_WINDOW_MS,
  ROOM_FANOUT_RATE_PER_SECOND,
  WAITING_TIMEOUT_MS,
  bytesToBase64Url,
  generatePeerId,
  generateRoomId,
  type ServerFrame,
} from "@aside/protocol";
import { describe, expect, it } from "vitest";
import type { Clock } from "./clock.js";
import { RoomManager, type Connection } from "./manager.js";

class FakeClock implements Clock {
  t = 1_700_000_000_000;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

class FakeConn implements Connection {
  frames: ServerFrame[] = [];
  closed = false;
  send(frame: ServerFrame): void {
    this.frames.push(frame);
  }
  close(): void {
    this.closed = true;
  }
  ofType<T extends ServerFrame["type"]>(type: T): Extract<ServerFrame, { type: T }>[] {
    return this.frames.filter((f): f is Extract<ServerFrame, { type: T }> => f.type === type);
  }
  reset(): void {
    this.frames = [];
  }
}

function makeAuth(fill = 7): string {
  return bytesToBase64Url(new Uint8Array(32).fill(fill));
}

const CIPHER = bytesToBase64Url(new Uint8Array(64).fill(9));
const IP = "10.0.0.1";

function setup(maxDeadRooms = 20_000) {
  const clock = new FakeClock();
  const manager = new RoomManager({ clock, maxDeadRooms });
  const roomId = generateRoomId();
  const auth = makeAuth();
  const creatorId = generatePeerId();
  const creator = new FakeConn();
  expect(manager.join(roomId, auth, creatorId, IP, creator, 3).ok).toBe(true);
  return { clock, manager, roomId, auth, creatorId, creator };
}

function join(s: ReturnType<typeof setup>, cap?: number) {
  const peerId = generatePeerId();
  const conn = new FakeConn();
  const result = s.manager.join(s.roomId, s.auth, peerId, IP, conn, cap);
  return { peerId, conn, result };
}

function send(s: ReturnType<typeof setup>, peerId: string, conn: FakeConn, n = 1): void {
  s.manager.msg(s.roomId, peerId, conn, { type: "msg", n, c: CIPHER });
}

describe("RoomManager groups", () => {
  it("honors cap 3 and ignores cap values from later joiners", () => {
    const s = setup();
    const b = join(s, 1);
    const c = join(s, 2);
    expect(b.result.ok).toBe(true);
    expect(c.result.ok).toBe(true);
    const d = join(s);
    expect(d.result).toEqual({ ok: false, code: "room_full" });
    expect(d.conn.frames).toHaveLength(0);
    expect(s.creator.ofType("joined")[0]!.cap).toBe(3);
    expect(s.creator.ofType("joined")[0]!.members).toEqual([]);
  });

  it("rejects invalid cap values before creating a room", () => {
    const clock = new FakeClock();
    const manager = new RoomManager({ clock });
    for (const cap of [1, 1.5, MAX_PEERS + 1]) {
      const result = manager.join(
        generateRoomId(),
        makeAuth(),
        generatePeerId(),
        IP,
        new FakeConn(),
        cap,
      );
      expect(result).toEqual({ ok: false, code: "bad_cap" });
    }
    expect(manager.size).toBe(0);
  });

  it("rejects malformed identifiers and mismatched auth without mutating the room", () => {
    const s = setup();
    const conn = new FakeConn();
    expect(s.manager.join("bad-room", s.auth, s.creatorId, IP, conn)).toEqual({
      ok: false,
      code: "bad_room",
    });
    expect(s.manager.join(s.roomId, s.auth, "bad-peer", IP, conn)).toEqual({
      ok: false,
      code: "bad_format",
    });
    expect(s.manager.join(s.roomId, "short", generatePeerId(), IP, conn)).toEqual({
      ok: false,
      code: "bad_auth",
    });
    expect(s.manager.join(s.roomId, makeAuth(9), generatePeerId(), IP, conn)).toEqual({
      ok: false,
      code: "bad_auth",
    });
    expect(s.manager.size).toBe(1);
    expect(join(s).result.ok).toBe(true);
  });

  it("enforces the global room cap", () => {
    const clock = new FakeClock();
    const manager = new RoomManager({ clock, maxRooms: 2 });
    for (let i = 0; i < 2; i++) {
      expect(
        manager.join(
          generateRoomId(),
          makeAuth(i + 1),
          generatePeerId(),
          `${IP}-${i}`,
          new FakeConn(),
        ).ok,
      ).toBe(true);
    }
    expect(
      manager.join(generateRoomId(), makeAuth(3), generatePeerId(), `${IP}-3`, new FakeConn()),
    ).toEqual({ ok: false, code: "room_full" });
    expect(manager.size).toBe(2);
  });

  it("stamps the sender label, fans out to every other connected member, and never echoes", () => {
    const s = setup();
    const b = join(s);
    const c = join(s);
    const aLabel = s.creator.ofType("joined")[0]!.label;
    s.creator.reset();
    b.conn.reset();
    c.conn.reset();

    send(s, s.creatorId, s.creator);
    expect(b.conn.ofType("msg")).toEqual([{ type: "msg", from: aLabel, c: CIPHER }]);
    expect(c.conn.ofType("msg")).toEqual([{ type: "msg", from: aLabel, c: CIPHER }]);
    expect(s.creator.ofType("msg")).toHaveLength(0);
    expect(s.creator.ofType("ack")).toEqual([{ type: "ack", n: 1 }]);
  });

  it("drops messages without an ack when no other member is connected", () => {
    const s = setup();
    s.creator.reset();
    send(s, s.creatorId, s.creator);
    expect(s.creator.ofType("ack")).toHaveLength(0);
    expect(s.creator.ofType("msg")).toHaveLength(0);
  });

  it("keeps labels unique for the room lifetime, including after departure", () => {
    const s = setup();
    const b = join(s);
    const c = join(s);
    const bLabel = b.conn.ofType("joined")[0]!.label;
    s.manager.leave(s.roomId, b.peerId, b.conn);
    expect(
      s.creator.ofType("peer").some((frame) => frame.state === "left" && frame.label === bLabel),
    ).toBe(true);
    const d = join(s);
    expect(d.result.ok).toBe(true);
    const dLabel = d.conn.ofType("joined")[0]!.label;
    expect(dLabel).not.toBe(bLabel);
    expect(dLabel).not.toBe(c.conn.ofType("joined")[0]!.label);
    expect(dLabel).not.toBe(s.creator.ofType("joined")[0]!.label);
  });

  it("validates a creator's cap before opening a room", () => {
    const clock = new FakeClock();
    const manager = new RoomManager({ clock });
    for (const cap of [1, 2.5, MAX_PEERS + 1]) {
      const result = manager.join(
        generateRoomId(),
        makeAuth(33),
        generatePeerId(),
        IP,
        new FakeConn(),
        cap,
      );
      expect(result).toEqual({ ok: false, code: "bad_cap" });
    }
    expect(manager.size).toBe(0);
  });

  it("ignores invalid numeric cap values from non-creator joiners", () => {
    const s = setup();
    const b = join(s, 1);
    expect(b.result.ok).toBe(true);
    expect(b.conn.ofType("joined")[0]!.cap).toBe(3);
  });

  it("rejects oversized ciphertext and retains the per-peer message burst limit", () => {
    const s = setup();
    const b = join(s);
    s.creator.reset();
    s.manager.msg(s.roomId, s.creatorId, s.creator, {
      type: "msg",
      n: 0,
      c: "A".repeat(MAX_FRAME_BYTES + 1),
    });
    expect(s.creator.ofType("err")).toEqual([{ type: "err", code: "too_large" }]);
    expect(b.conn.ofType("msg")).toHaveLength(0);
    s.creator.reset();
    for (let n = 0; n < MSG_RATE_BURST + 1; n++) send(s, s.creatorId, s.creator, n);
    expect(b.conn.ofType("msg")).toHaveLength(MSG_RATE_BURST);
    expect(s.creator.ofType("ack")).toHaveLength(MSG_RATE_BURST);
    expect(s.creator.ofType("err").at(-1)).toEqual({ type: "err", code: "rate_limited" });
  });

  it("reconnects an existing member within grace using the same label", () => {
    const s = setup();
    const b = join(s);
    const originalLabel = b.conn.ofType("joined")[0]!.label;
    s.manager.disconnect(s.roomId, b.peerId, b.conn);
    s.clock.advance(RECONNECT_GRACE_MS - 1);
    s.manager.tick();
    const replacement = new FakeConn();
    expect(s.manager.join(s.roomId, s.auth, b.peerId, IP, replacement)).toEqual({
      ok: true,
      label: originalLabel,
    });
    expect(replacement.ofType("joined")[0]!.label).toBe(originalLabel);
    expect(s.creator.ofType("peer").at(-1)).toEqual({
      type: "peer",
      state: "back",
      label: originalLabel,
      count: 2,
    });
  });

  it("restarts the idle window on forwarded message activity", () => {
    const s = setup();
    const b = join(s);
    s.clock.advance(IDLE_TIMEOUT_MS - 1);
    send(s, s.creatorId, s.creator);
    s.clock.advance(IDLE_TIMEOUT_MS - 1);
    s.manager.tick();
    expect(s.manager.size).toBe(1);
    s.clock.advance(1);
    s.manager.tick();
    expect(s.manager.size).toBe(0);
    expect(s.creator.ofType("closed")).toEqual([{ type: "closed", reason: "idle" }]);
    expect(b.conn.ofType("closed")).toHaveLength(1);
  });

  it("retires an expired non-creator before accepting a later join", () => {
    const s = setup();
    const b = join(s);
    const c = join(s);
    const oldLabel = b.conn.ofType("joined")[0]!.label;
    s.manager.disconnect(s.roomId, b.peerId, b.conn);
    s.clock.advance(RECONNECT_GRACE_MS);
    const d = join(s);
    expect(d.result.ok).toBe(true);
    expect(
      s.creator.ofType("peer").some((frame) => frame.state === "left" && frame.label === oldLabel),
    ).toBe(true);
    expect(d.conn.ofType("joined")[0]!.label).not.toBe(oldLabel);
    expect(c.result.ok).toBe(true);
  });

  it("locks only when creator asks and blocks later joins without disclosing a distinct state", () => {
    const s = setup();
    const b = join(s);
    expect(s.manager.lock(s.roomId, b.peerId, b.conn)).toBe("not_creator");
    expect(b.conn.ofType("locked")).toHaveLength(0);
    expect(s.manager.lock(s.roomId, s.creatorId, s.creator)).toBeNull();
    expect(s.creator.ofType("locked")).toHaveLength(1);
    expect(b.conn.ofType("locked")).toHaveLength(1);
    const late = join(s);
    expect(late.result).toEqual({ ok: false, code: "room_locked" });
  });

  it("fans out through cap 8 and rejects over-cap joins", () => {
    // Creator cap is explicitly 8 for this case.
    const clock = new FakeClock();
    const manager = new RoomManager({ clock });
    const roomId = generateRoomId();
    const auth = makeAuth(4);
    const creatorId = generatePeerId();
    const creator = new FakeConn();
    manager.join(roomId, auth, creatorId, IP, creator, MAX_PEERS);
    const members: Array<{ peerId: string; conn: FakeConn }> = [];
    for (let i = 1; i < MAX_PEERS; i++) {
      const peerId = generatePeerId();
      const conn = new FakeConn();
      expect(manager.join(roomId, auth, peerId, IP, conn).ok).toBe(true);
      members.push({ peerId, conn });
    }
    const labels = members.map((member) => member.conn.ofType("joined")[0]!.members[0]);
    for (const member of members) member.conn.reset();
    manager.msg(roomId, creatorId, creator, { type: "msg", n: 7, c: CIPHER });
    for (const member of members) expect(member.conn.ofType("msg")).toHaveLength(1);
    expect(creator.ofType("ack").at(-1)).toEqual({ type: "ack", n: 7 });
    expect(new Set(labels).size).toBe(1);
    const extra = new FakeConn();
    expect(manager.join(roomId, auth, generatePeerId(), IP, extra)).toEqual({
      ok: false,
      code: "room_full",
    });
    expect(manager.size).toBe(1);
  });
});

describe("RoomManager lifecycle", () => {
  it("destroys with creator_left after creator's reconnect grace expires", () => {
    const s = setup();
    const b = join(s);
    s.creator.reset();
    b.conn.reset();
    s.manager.disconnect(s.roomId, s.creatorId, s.creator);
    s.clock.advance(CREATOR_GRACE_MS - 1);
    s.manager.tick();
    expect(s.manager.size).toBe(1);
    s.clock.advance(1);
    s.manager.tick();
    expect(s.manager.size).toBe(0);
    expect(b.conn.ofType("closed")).toEqual([{ type: "closed", reason: "creator_left" }]);
  });

  it("removes an absent non-creator after grace and continues the room without reusing label", () => {
    const s = setup();
    const b = join(s);
    const bLabel = b.conn.ofType("joined")[0]!.label;
    const c = join(s);
    s.manager.disconnect(s.roomId, b.peerId, b.conn);
    s.clock.advance(RECONNECT_GRACE_MS);
    s.manager.tick();
    expect(s.manager.size).toBe(1);
    expect(s.creator.ofType("peer").some((f) => f.state === "left" && f.label === bLabel)).toBe(
      true,
    );
    const d = join(s);
    expect(d.result.ok).toBe(true);
    expect(d.conn.ofType("joined")[0]!.label).not.toBe(bLabel);
    expect(c.result.ok).toBe(true);
  });

  it("destroys when only one member remains connected beyond grace", () => {
    const s = setup();
    const b = join(s);
    s.manager.disconnect(s.roomId, b.peerId, b.conn);
    s.clock.advance(CREATOR_GRACE_MS);
    s.manager.tick();
    expect(s.manager.size).toBe(0);
    expect(s.creator.ofType("closed")).toEqual([{ type: "closed", reason: "peer_left" }]);
  });

  it("explicit leave immediately removes a non-creator and closes the two-person room", () => {
    const s = setup();
    const b = join(s);
    s.creator.reset();
    s.manager.leave(s.roomId, b.peerId, b.conn);
    expect(s.manager.size).toBe(0);
    expect(s.creator.ofType("closed")).toEqual([{ type: "closed", reason: "peer_left" }]);
  });

  it("creator leave immediately destroys all members with creator_left", () => {
    const s = setup();
    const b = join(s);
    b.conn.reset();
    s.manager.leave(s.roomId, s.creatorId, s.creator);
    expect(s.manager.size).toBe(0);
    expect(b.conn.ofType("closed")).toEqual([{ type: "closed", reason: "creator_left" }]);
  });

  it("preserves one-peer rate limits and the aggregate fan-out budget", () => {
    const clock = new FakeClock();
    const manager = new RoomManager({ clock });
    const roomId = generateRoomId();
    const auth = makeAuth(5);
    const members: Array<{ id: string; conn: FakeConn }> = [];
    for (let i = 0; i < 8; i++) {
      const id = generatePeerId();
      const conn = new FakeConn();
      expect(manager.join(roomId, auth, id, `${IP}-${i}`, conn, MAX_PEERS).ok).toBe(true);
      members.push({ id, conn });
    }
    let n = 0;
    // Six senders x 5 token-bucket burst messages, each forwarded to 7: 210 frames.
    for (const member of members.slice(0, 6)) {
      for (let i = 0; i < 5; i++)
        manager.msg(roomId, member.id, member.conn, { type: "msg", n: n++, c: CIPHER });
    }
    const delivered = members.reduce((sum, member) => sum + member.conn.ofType("msg").length, 0);
    expect(delivered).toBe(196); // Forwarding is atomic per message; a rejected fan-out is never partial.
    expect(delivered).toBeLessThanOrEqual(ROOM_FANOUT_RATE_PER_SECOND);
    expect(
      members.some((member) =>
        member.conn.ofType("err").some((frame) => frame.code === "rate_limited"),
      ),
    ).toBe(true);
    const extraSender = members[6]!;
    const before = extraSender.conn.ofType("err").length;
    manager.msg(roomId, extraSender.id, extraSender.conn, { type: "msg", n: n++, c: CIPHER });
    expect(extraSender.conn.ofType("err").length).toBe(before + 1);
    expect(extraSender.conn.ofType("err").at(-1)).toEqual({ type: "err", code: "rate_limited" });
    clock.advance(1000);
    manager.msg(roomId, extraSender.id, extraSender.conn, { type: "msg", n: n++, c: CIPHER });
    expect(extraSender.conn.ofType("ack").length).toBeGreaterThan(0);
  });

  it("preserves room-create limits per IP", () => {
    const clock = new FakeClock();
    const manager = new RoomManager({ clock });
    for (let i = 0; i < ROOM_CREATE_LIMIT_PER_IP; i++) {
      expect(
        manager.join(generateRoomId(), makeAuth(), generatePeerId(), IP, new FakeConn()).ok,
      ).toBe(true);
    }
    expect(
      manager.join(generateRoomId(), makeAuth(), generatePeerId(), IP, new FakeConn()),
    ).toEqual({ ok: false, code: "rate_limited" });
    expect(
      manager.join(generateRoomId(), makeAuth(), generatePeerId(), "10.0.0.2", new FakeConn()).ok,
    ).toBe(true);
    clock.advance(ROOM_CREATE_WINDOW_MS);
    expect(
      manager.join(generateRoomId(), makeAuth(), generatePeerId(), IP, new FakeConn()).ok,
    ).toBe(true);
  });

  it("preserves waiting, idle, max-age, and dead-link lifecycle bounds", () => {
    const s = setup();
    s.clock.advance(WAITING_TIMEOUT_MS);
    s.manager.tick();
    expect(s.manager.size).toBe(0);
    expect(s.creator.ofType("closed")).toEqual([{ type: "closed", reason: "waiting_timeout" }]);

    const next = setup();
    const b = join(next);
    next.clock.advance(IDLE_TIMEOUT_MS);
    next.manager.tick();
    expect(next.manager.size).toBe(0);
    expect(next.creator.ofType("closed")).toEqual([{ type: "closed", reason: "idle" }]);
    expect(b.conn.ofType("closed")).toHaveLength(1);

    const last = setup();
    last.clock.advance(MAX_ROOM_AGE_MS);
    last.manager.tick();
    expect(last.manager.size).toBe(0);
    expect(last.creator.ofType("closed")).toEqual([{ type: "closed", reason: "expired" }]);
  });

  it("bounds tombstones and prevents a destroyed link from reopening", () => {
    const s = setup(1);
    s.manager.leave(s.roomId, s.creatorId, s.creator);
    expect(s.manager.deadSize).toBe(1);
    expect(s.manager.join(s.roomId, s.auth, generatePeerId(), IP, new FakeConn())).toEqual({
      ok: false,
      closed: "creator_left",
    });
    const otherRoom = generateRoomId();
    s.manager.join(otherRoom, makeAuth(8), generatePeerId(), IP, new FakeConn());
    s.manager.tick();
    expect(s.manager.deadSize).toBeLessThanOrEqual(1);
  });
});
