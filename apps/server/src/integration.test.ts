import {
  CREATOR_GRACE_MS,
  bytesToBase64Url,
  generatePeerId,
  generateRoomId,
  parseServerFrame,
  type ClientFrame,
  type JoinedFrame,
  type ServerFrame,
} from "@aside/protocol";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Clock } from "./clock.js";
import { type AsideServer, createAsideServer } from "./server.js";

class FakeClock implements Clock {
  private time = 1_700_000_000_000;
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    this.time += ms;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Client {
  readonly frames: ServerFrame[] = [];
  private constructor(readonly ws: WebSocket) {}

  static async open(port: number, roomId: string): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${roomId}`);
    const client = new Client(ws);
    ws.on("message", (data) => {
      const frame = parseServerFrame(data.toString());
      if (!frame) throw new Error(`unparsable server frame: ${data.toString()}`);
      client.frames.push(frame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return client;
  }

  send(frame: ClientFrame): void {
    this.ws.send(JSON.stringify(frame));
  }
  sendRaw(text: string): void {
    this.ws.send(text);
  }

  async waitFor(pred: (frame: ServerFrame) => boolean, timeoutMs = 3000): Promise<ServerFrame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.frames.find(pred);
      if (found) return found;
      await sleep(5);
    }
    throw new Error(`timeout waiting for frame; saw: ${JSON.stringify(this.frames)}`);
  }

  ofType<T extends ServerFrame["type"]>(type: T): Extract<ServerFrame, { type: T }>[] {
    return this.frames.filter((f): f is Extract<ServerFrame, { type: T }> => f.type === type);
  }
  close(): void {
    this.ws.close();
  }
}

function makeAuth(fill = 7): string {
  return bytesToBase64Url(new Uint8Array(32).fill(fill));
}

interface Member {
  client: Client;
  peerId: string;
  label: string;
}

async function joinRoom(port: number, roomId: string, auth: string, cap?: number): Promise<Member> {
  const client = await Client.open(port, roomId);
  const peerId = generatePeerId();
  client.send(
    cap === undefined ? { type: "join", auth, peerId } : { type: "join", auth, peerId, cap },
  );
  const joined = (await client.waitFor((f) => f.type === "joined")) as JoinedFrame;
  expect(joined.label).toMatch(/^[0-9]{4}$/);
  return { client, peerId, label: joined.label };
}

function cipher(fill: number): string {
  return bytesToBase64Url(new Uint8Array(96).fill(fill));
}

describe("relay integration", () => {
  let server: AsideServer;
  let port: number;
  const clock = new FakeClock();

  beforeAll(async () => {
    server = createAsideServer({ clock });
    port = await server.listen(0);
  });

  afterAll(async () => {
    await server.close();
  });

  it("serves /healthz and 404s everything else", async () => {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
    const missing = await fetch(`http://127.0.0.1:${port}/`);
    expect(missing.status).toBe(404);
  });

  it("fans out to three members with stamped labels, no sender echo, and no late-join history", async () => {
    const roomId = generateRoomId();
    const auth = makeAuth();
    const a = await joinRoom(port, roomId, auth, 3);
    const b = await joinRoom(port, roomId, auth);
    const first = cipher(31);
    a.client.send({ type: "msg", n: 1, c: first });
    expect(await b.client.waitFor((f) => f.type === "msg")).toEqual({
      type: "msg",
      from: a.label,
      c: first,
    });
    expect(await a.client.waitFor((f) => f.type === "ack")).toEqual({ type: "ack", n: 1 });
    await sleep(25);
    expect(a.client.ofType("msg")).toHaveLength(0);

    const c = await joinRoom(port, roomId, auth);
    expect(c.client.ofType("msg")).toHaveLength(0);
    const second = cipher(32);
    b.client.send({ type: "msg", n: 1, c: second });
    expect(await a.client.waitFor((f) => f.type === "msg" && f.c === second)).toEqual({
      type: "msg",
      from: b.label,
      c: second,
    });
    expect(await c.client.waitFor((f) => f.type === "msg" && f.c === second)).toEqual({
      type: "msg",
      from: b.label,
      c: second,
    });
    expect(b.client.ofType("msg").filter((frame) => frame.c === second)).toHaveLength(0);

    // Fourth join fails because the creator selected cap 3.
    const d = await Client.open(port, roomId);
    d.send({ type: "join", auth, peerId: generatePeerId() });
    expect(await d.waitFor((f) => f.type === "err")).toEqual({ type: "err", code: "room_full" });

    a.client.send({ type: "leave" });
    await b.client.waitFor((f) => f.type === "closed");
    await c.client.waitFor((f) => f.type === "closed");
    expect(server.manager.size).toBe(0);
    a.client.close();
    b.client.close();
    c.client.close();
    d.close();
  });

  it("locks a group for its creator and reports a full-or-closed-safe room_locked code", async () => {
    const roomId = generateRoomId();
    const auth = makeAuth(11);
    const a = await joinRoom(port, roomId, auth, 4);
    const b = await joinRoom(port, roomId, auth);
    const c = await joinRoom(port, roomId, auth);
    b.client.send({ type: "lock" });
    expect(await b.client.waitFor((f) => f.type === "err")).toEqual({
      type: "err",
      code: "not_creator",
    });
    expect(a.client.ofType("locked")).toHaveLength(0);
    a.client.send({ type: "lock" });
    await a.client.waitFor((f) => f.type === "locked");
    await b.client.waitFor((f) => f.type === "locked");
    await c.client.waitFor((f) => f.type === "locked");
    const late = await Client.open(port, roomId);
    late.send({ type: "join", auth, peerId: generatePeerId() });
    expect(await late.waitFor((f) => f.type === "err")).toEqual({
      type: "err",
      code: "room_locked",
    });
    a.client.send({ type: "leave" });
    await b.client.waitFor((f) => f.type === "closed");
    await c.client.waitFor((f) => f.type === "closed");
    expect(server.manager.size).toBe(0);
    a.client.close();
    b.client.close();
    c.client.close();
    late.close();
  });

  it("an explicit non-creator leave broadcasts left immediately and keeps a larger room open", async () => {
    const roomId = generateRoomId();
    const auth = makeAuth(12);
    const a = await joinRoom(port, roomId, auth, 4);
    const b = await joinRoom(port, roomId, auth);
    const c = await joinRoom(port, roomId, auth);
    b.client.send({ type: "leave" });
    expect(await a.client.waitFor((f) => f.type === "peer" && f.state === "left")).toEqual({
      type: "peer",
      state: "left",
      label: b.label,
      count: 2,
    });
    expect(await c.client.waitFor((f) => f.type === "peer" && f.state === "left")).toEqual({
      type: "peer",
      state: "left",
      label: b.label,
      count: 2,
    });
    expect(server.manager.size).toBe(1);
    a.client.send({ type: "leave" });
    expect(await c.client.waitFor((f) => f.type === "closed")).toEqual({
      type: "closed",
      reason: "creator_left",
    });
    expect(server.manager.size).toBe(0);
    a.client.close();
    b.client.close();
    c.client.close();
  });

  it("a creator disconnect destroys all group members with creator_left", async () => {
    const roomId = generateRoomId();
    const auth = makeAuth(13);
    const a = await joinRoom(port, roomId, auth, 4);
    const b = await joinRoom(port, roomId, auth);
    const c = await joinRoom(port, roomId, auth);
    a.client.close();
    await b.client.waitFor((f) => f.type === "peer" && f.state === "away");
    clock.advance(CREATOR_GRACE_MS);
    server.manager.tick();
    expect(await b.client.waitFor((f) => f.type === "closed")).toEqual({
      type: "closed",
      reason: "creator_left",
    });
    expect(await c.client.waitFor((f) => f.type === "closed")).toEqual({
      type: "closed",
      reason: "creator_left",
    });
    expect(server.manager.size).toBe(0);
    b.client.close();
    c.client.close();
  });

  it("rejects an invalid creator cap with bad_cap", async () => {
    const roomId = generateRoomId();
    const client = await Client.open(port, roomId);
    client.sendRaw(
      JSON.stringify({ type: "join", auth: makeAuth(19), peerId: generatePeerId(), cap: 1 }),
    );
    expect(await client.waitFor((f) => f.type === "err")).toEqual({ type: "err", code: "bad_cap" });
    expect(server.manager.size).toBe(0);
    client.close();
  });

  it("rejects sender-controlled from labels in join and message frames", async () => {
    const invalidJoin = await Client.open(port, generateRoomId());
    invalidJoin.sendRaw(
      JSON.stringify({ type: "join", auth: makeAuth(), peerId: generatePeerId(), from: "0000" }),
    );
    expect(await invalidJoin.waitFor((f) => f.type === "err")).toEqual({
      type: "err",
      code: "bad_format",
    });
    expect(server.manager.size).toBe(0);
    invalidJoin.close();

    const roomId = generateRoomId();
    const member = await joinRoom(port, roomId, makeAuth(18));
    member.client.sendRaw(JSON.stringify({ type: "msg", n: 1, c: cipher(44), from: "0000" }));
    expect(await member.client.waitFor((f) => f.type === "err")).toEqual({
      type: "err",
      code: "bad_format",
    });
    member.client.send({ type: "leave" });
    expect(await member.client.waitFor((f) => f.type === "closed")).toEqual({
      type: "closed",
      reason: "creator_left",
    });
    expect(server.manager.size).toBe(0);
    member.client.close();
  });

  it("forwards opaque ciphertext unchanged and acks only forwarded frames", async () => {
    const roomId = generateRoomId();
    const auth = makeAuth(17);
    const a = await joinRoom(port, roomId, auth, 2);
    const b = await joinRoom(port, roomId, auth);
    const c = cipher(33);
    a.client.send({ type: "msg", n: 1, c });
    expect(await b.client.waitFor((f) => f.type === "msg")).toEqual({
      type: "msg",
      from: a.label,
      c,
    });
    expect(await a.client.waitFor((f) => f.type === "ack")).toEqual({ type: "ack", n: 1 });
    a.client.send({ type: "leave" });
    await b.client.waitFor((f) => f.type === "closed");
    b.client.close();
    a.client.close();
  });

  it("holds no rooms in memory after everyone has left", async () => {
    expect(server.manager.size).toBe(0);
  });
});
