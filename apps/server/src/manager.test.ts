import {
  IDLE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_ROOM_AGE_MS,
  MSG_RATE_BURST,
  RECONNECT_GRACE_MS,
  ROOM_CREATE_LIMIT_PER_IP,
  ROOM_CREATE_WINDOW_MS,
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

interface Setup {
  clock: FakeClock;
  manager: RoomManager;
  roomId: string;
  auth: string;
  aId: string;
  bId: string;
  a: FakeConn;
  b: FakeConn;
}

function setup(options: { maxRooms?: number } = {}): Setup {
  const clock = new FakeClock();
  const manager = new RoomManager({ clock, ...options });
  const roomId = generateRoomId();
  const auth = makeAuth();
  const aId = generatePeerId();
  const bId = generatePeerId();
  const a = new FakeConn();
  const b = new FakeConn();
  return { clock, manager, roomId, auth, aId, bId, a, b };
}

function joinA(s: Setup): void {
  const result = s.manager.join(s.roomId, s.auth, s.aId, "10.0.0.1", s.a);
  expect(result.ok).toBe(true);
}

function joinB(s: Setup): void {
  const result = s.manager.join(s.roomId, s.auth, s.bId, "10.0.0.2", s.b);
  expect(result.ok).toBe(true);
}

function msgFrame(n: number, c: string) {
  return { type: "msg" as const, n, c };
}

const CIPHER = bytesToBase64Url(new Uint8Array(64).fill(9));

describe("RoomManager join", () => {
  it("creates a room on first valid join with a 4-digit label", () => {
    const s = setup();
    joinA(s);
    expect(s.manager.size).toBe(1);
    const joined = s.a.ofType("joined");
    expect(joined).toHaveLength(1);
    expect(joined[0]!.label).toMatch(/^[0-9]{4}$/);
    expect(joined[0]!.peers).toBe(1);
    expect(joined[0]!.peerLabel).toBeUndefined();
  });

  it("lets a second peer in with matching auth and notifies both sides", () => {
    const s = setup();
    joinA(s);
    joinB(s);
    expect(s.manager.size).toBe(1);

    const aJoined = s.a.ofType("joined")[0]!;
    const bJoined = s.b.ofType("joined")[0]!;
    expect(bJoined.peerLabel).toBe(aJoined.label);
    expect(bJoined.peers).toBe(2);
    expect(aJoined.peers).toBe(1);

    const aNotified = s.a.ofType("peer");
    expect(aNotified).toHaveLength(1);
    expect(aNotified[0]).toEqual({ type: "peer", state: "joined", peerLabel: bJoined.label });
    // Labels are distinct within the room.
    expect(aJoined.label).not.toBe(bJoined.label);
  });

  it("rejects a third distinct peerId with room_full", () => {
    const s = setup();
    joinA(s);
    joinB(s);
    const c = new FakeConn();
    const result = s.manager.join(s.roomId, s.auth, generatePeerId(), "10.0.0.3", c);
    expect(result).toEqual({ ok: false, code: "room_full" });
    expect(c.frames).toHaveLength(0);
    expect(s.manager.size).toBe(1);
  });

  it("rejects a wrong auth token with bad_auth and keeps the room", () => {
    const s = setup();
    joinA(s);
    const impostor = new FakeConn();
    const result = s.manager.join(s.roomId, makeAuth(9), generatePeerId(), "10.0.0.4", impostor);
    expect(result).toEqual({ ok: false, code: "bad_auth" });
    expect(impostor.frames).toHaveLength(0);
    expect(s.manager.size).toBe(1);
    // The real owner can still join the second slot.
    joinB(s);
    expect(s.b.ofType("joined")).toHaveLength(1);
  });

  it("rejects malformed room ids, peer ids and auth", () => {
    const s = setup();
    const conn = new FakeConn();
    expect(s.manager.join("nope", s.auth, s.aId, "ip", conn)).toEqual({
      ok: false,
      code: "bad_room",
    });
    expect(s.manager.join(generateRoomId(), s.auth, "bad-peer", "ip", conn)).toEqual({
      ok: false,
      code: "bad_format",
    });
    expect(s.manager.join(generateRoomId(), "short", s.aId, "ip", conn)).toEqual({
      ok: false,
      code: "bad_auth",
    });
    expect(s.manager.size).toBe(0);
  });
});

describe("RoomManager forwarding", () => {
  it("forwards ciphertext to the other peer, acks the sender and never echoes", () => {
    const s = setup();
    joinA(s);
    joinB(s);
    s.a.reset();
    s.b.reset();

    s.manager.msg(s.roomId, s.aId, s.a, msgFrame(1, CIPHER));

    expect(s.b.ofType("msg")).toEqual([{ type: "msg", c: CIPHER }]);
    expect(s.a.ofType("ack")).toEqual([{ type: "ack", n: 1 }]);
    // The sender must never receive its own message.
    expect(s.a.ofType("msg")).toHaveLength(0);
  });

  it("drops messages when no other peer is connected (no ack)", () => {
    const s = setup();
    joinA(s);
    s.a.reset();
    s.manager.msg(s.roomId, s.aId, s.a, msgFrame(1, CIPHER));
    expect(s.a.ofType("ack")).toHaveLength(0);
    expect(s.a.ofType("msg")).toHaveLength(0);
  });

  it("rejects oversized ciphertext with too_large", () => {
    const s = setup();
    joinA(s);
    joinB(s);
    s.a.reset();
    s.b.reset();
    const huge = "A".repeat(MAX_FRAME_BYTES + 1);
    s.manager.msg(s.roomId, s.aId, s.a, msgFrame(1, huge));
    expect(s.a.ofType("err")).toEqual([{ type: "err", code: "too_large" }]);
    expect(s.b.ofType("msg")).toHaveLength(0);
  });

  it("rate limits a peer at burst + rate per second", () => {
    const s = setup();
    joinA(s);
    joinB(s);
    s.a.reset();
    s.b.reset();

    for (let i = 0; i < MSG_RATE_BURST; i++) {
      s.manager.msg(s.roomId, s.aId, s.a, msgFrame(i, CIPHER));
    }
    expect(s.b.ofType("msg")).toHaveLength(MSG_RATE_BURST);

    s.manager.msg(s.roomId, s.aId, s.a, msgFrame(99, CIPHER));
    expect(s.a.ofType("err")).toEqual([{ type: "err", code: "rate_limited" }]);
    expect(s.b.ofType("msg")).toHaveLength(MSG_RATE_BURST);

    // 5 per second refill.
    s.clock.advance(1000);
    for (let i = 0; i < 5; i++) {
      s.manager.msg(s.roomId, s.aId, s.a, msgFrame(100 + i, CIPHER));
    }
    expect(s.b.ofType("msg")).toHaveLength(MSG_RATE_BURST + 5);
    s.manager.msg(s.roomId, s.aId, s.a, msgFrame(200, CIPHER));
    expect(s.a.ofType("err")).toHaveLength(2);
  });

  it("rate limits room creation per ip inside the window", () => {
    const clock = new FakeClock();
    const manager = new RoomManager({ clock });
    for (let i = 0; i < ROOM_CREATE_LIMIT_PER_IP; i++) {
      const result = manager.join(
        generateRoomId(),
        makeAuth(),
        generatePeerId(),
        "1.2.3.4",
        new FakeConn(),
      );
      expect(result.ok).toBe(true);
    }
    const blocked = manager.join(
      generateRoomId(),
      makeAuth(),
      generatePeerId(),
      "1.2.3.4",
      new FakeConn(),
    );
    expect(blocked).toEqual({ ok: false, code: "rate_limited" });

    // A different ip is unaffected.
    const otherIp = manager.join(
      generateRoomId(),
      makeAuth(),
      generatePeerId(),
      "5.6.7.8",
      new FakeConn(),
    );
    expect(otherIp.ok).toBe(true);

    // Window expires.
    clock.advance(ROOM_CREATE_WINDOW_MS);
    const afterWindow = manager.join(
      generateRoomId(),
      makeAuth(),
      generatePeerId(),
      "1.2.3.4",
      new FakeConn(),
    );
    expect(afterWindow.ok).toBe(true);
  });

  it("enforces the global room cap", () => {
    const clock = new FakeClock();
    const manager = new RoomManager({ clock, maxRooms: 2 });
    expect(
      manager.join(generateRoomId(), makeAuth(), generatePeerId(), "1.1.1.1", new FakeConn()).ok,
    ).toBe(true);
    expect(
      manager.join(generateRoomId(), makeAuth(), generatePeerId(), "2.2.2.2", new FakeConn()).ok,
    ).toBe(true);
    expect(
      manager.join(generateRoomId(), makeAuth(), generatePeerId(), "3.3.3.3", new FakeConn()),
    ).toEqual({
      ok: false,
      code: "room_full",
    });
    expect(manager.size).toBe(2);
  });
});

describe("RoomManager lifecycle", () => {
  it("reconnects a known peerId within the grace window", () => {
    const s = setup();
    joinA(s);
    joinB(s);
    const aLabel = s.a.ofType("joined")[0]!.label;

    s.manager.disconnect(s.roomId, s.aId, s.a);
    expect(s.b.ofType("peer")).toEqual([{ type: "peer", state: "away", peerLabel: aLabel }]);
    expect(s.manager.size).toBe(1);

    s.clock.advance(RECONNECT_GRACE_MS - 1000);
    s.manager.tick();
    expect(s.manager.size).toBe(1);

    const a2 = new FakeConn();
    const result = s.manager.join(s.roomId, s.auth, s.aId, "10.0.0.1", a2);
    expect(result).toEqual({ ok: true, label: aLabel });
    expect(a2.ofType("joined")[0]!.peerLabel).toBe(s.b.ofType("joined")[0]!.label);
    expect(s.b.ofType("peer").at(-1)).toEqual({ type: "peer", state: "back", peerLabel: aLabel });

    // Still alive well past the grace window: the peer came back.
    s.clock.advance(RECONNECT_GRACE_MS * 2);
    s.manager.tick();
    expect(s.manager.size).toBe(1);
  });

  it("destroys the room when grace expires, telling the other peer peer_left", () => {
    const s = setup();
    joinA(s);
    joinB(s);
    s.b.reset();

    s.manager.disconnect(s.roomId, s.aId, s.a);
    s.clock.advance(RECONNECT_GRACE_MS - 1000);
    s.manager.tick();
    expect(s.manager.size).toBe(1);
    expect(s.b.ofType("closed")).toHaveLength(0);

    s.clock.advance(1000);
    s.manager.tick();
    expect(s.manager.size).toBe(0);
    expect(s.b.ofType("closed")).toEqual([{ type: "closed", reason: "peer_left" }]);
    expect(s.b.closed).toBe(true);
  });

  it("keeps a waiting room alive through the idle window, then hits waiting_timeout", () => {
    const s = setup();
    joinA(s);

    // Idle does not apply while waiting: only one person has joined.
    s.clock.advance(IDLE_TIMEOUT_MS + 60_000);
    s.manager.tick();
    expect(s.manager.size).toBe(1);

    s.clock.advance(WAITING_TIMEOUT_MS - IDLE_TIMEOUT_MS - 60_001);
    s.manager.tick();
    expect(s.manager.size).toBe(1); // 29m59s: still waiting

    s.clock.advance(1);
    s.manager.tick();
    expect(s.manager.size).toBe(0);
    expect(s.a.ofType("closed")).toEqual([{ type: "closed", reason: "waiting_timeout" }]);
  });

  it("destroys an idle two-person room after 10 minutes without messages", () => {
    const s = setup();
    joinA(s);
    joinB(s);
    s.a.reset();
    s.b.reset();

    s.clock.advance(IDLE_TIMEOUT_MS - 1000);
    s.manager.tick();
    expect(s.manager.size).toBe(1);

    s.clock.advance(1000);
    s.manager.tick();
    expect(s.manager.size).toBe(0);
    expect(s.a.ofType("closed")).toEqual([{ type: "closed", reason: "idle" }]);
    expect(s.b.ofType("closed")).toEqual([{ type: "closed", reason: "idle" }]);
  });

  it("resets the idle window on message activity", () => {
    const s = setup();
    joinA(s);
    joinB(s);

    for (let i = 0; i < 6; i++) {
      s.clock.advance(5 * 60 * 1000); // every 5 minutes
      s.manager.msg(s.roomId, s.aId, s.a, msgFrame(i, CIPHER));
      s.manager.tick();
      expect(s.manager.size).toBe(1);
    }
  });

  it("destroys any room at maximum age with expired", () => {
    const s = setup();
    joinA(s);
    joinB(s);
    s.a.reset();
    s.b.reset();

    const step = 5 * 60 * 1000;
    const steps = Math.floor(MAX_ROOM_AGE_MS / step);
    for (let i = 1; i < steps; i++) {
      s.clock.advance(step);
      s.manager.msg(s.roomId, s.aId, s.a, msgFrame(i, CIPHER));
      s.manager.tick();
      expect(s.manager.size).toBe(1);
    }
    s.clock.advance(step);
    s.manager.tick();
    expect(s.manager.size).toBe(0);
    expect(s.a.ofType("closed")).toEqual([{ type: "closed", reason: "expired" }]);
  });

  it("destroy on leave removes the room and notifies the other peer", () => {
    const s = setup();
    joinA(s);
    joinB(s);
    s.b.reset();

    s.manager.leave(s.roomId, s.aId, s.a);
    expect(s.manager.size).toBe(0);
    expect(s.b.ofType("closed")).toEqual([{ type: "closed", reason: "peer_left" }]);
    expect(s.b.closed).toBe(true);
    expect(s.a.closed).toBe(true);
  });

  it("leaves no rooms behind once everyone is gone", () => {
    const s = setup();
    joinA(s);
    joinB(s);
    s.manager.leave(s.roomId, s.bId, s.b);
    expect(s.manager.size).toBe(0);
    // Late disconnects from closed rooms are ignored.
    s.manager.disconnect(s.roomId, s.aId, s.a);
    s.manager.msg(s.roomId, s.aId, s.a, msgFrame(1, CIPHER));
    expect(s.manager.size).toBe(0);
  });

  it("notifies the joiner when the other person is away", () => {
    const s = setup();
    joinA(s);
    joinB(s);
    s.manager.disconnect(s.roomId, s.aId, s.a);

    const c = new FakeConn();
    // The remaining peer (b) reconnects while a is away.
    const result = s.manager.join(s.roomId, s.auth, s.bId, "10.0.0.2", c);
    expect(result.ok).toBe(true);
    const states = c.ofType("peer");
    expect(states).toEqual([
      { type: "peer", state: "away", peerLabel: s.a.ofType("joined")[0]!.label },
    ]);
  });
});
