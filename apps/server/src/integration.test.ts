import {
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
import { type AsideServer, createAsideServer } from "./server.js";

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
      // Frames that fail validation would silently vanish; tests assert on
      // what arrives, so remember unparsable input as a hard failure marker.
      if (!frame) {
        throw new Error(`unparsable server frame: ${data.toString()}`);
      }
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

async function joinRoom(port: number, roomId: string, auth: string): Promise<Member> {
  const client = await Client.open(port, roomId);
  const peerId = generatePeerId();
  client.send({ type: "join", auth, peerId });
  const joined = (await client.waitFor((f) => f.type === "joined")) as JoinedFrame;
  expect(joined.label).toMatch(/^[0-9]{4}$/);
  return { client, peerId, label: joined.label };
}

describe("relay integration", () => {
  let server: AsideServer;
  let port: number;

  beforeAll(async () => {
    server = createAsideServer();
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

  it("relays A -> B with ack, never echoes to A, and B -> A works", async () => {
    const before = server.manager.size;
    const roomId = generateRoomId();
    const auth = makeAuth();
    const a = await joinRoom(port, roomId, auth);
    expect(a.client.ofType("joined")[0]!.peers).toBe(1);

    const b = await joinRoom(port, roomId, auth);
    const bJoined = b.client.ofType("joined")[0]!;
    expect(bJoined.peers).toBe(2);
    expect(bJoined.peerLabel).toBe(a.label);

    // A is notified that B arrived.
    const notice = (await a.client.waitFor((f) => f.type === "peer")) as {
      type: "peer";
      state: string;
      peerLabel?: string;
    };
    expect(notice.state).toBe("joined");
    expect(notice.peerLabel).toBe(b.label);

    // A sends; B receives the exact ciphertext; A gets an ack.
    const ciphertext = bytesToBase64Url(new Uint8Array(96).fill(3));
    a.client.send({ type: "msg", n: 1, c: ciphertext });
    const received = (await b.client.waitFor((f) => f.type === "msg")) as { c: string };
    expect(received.c).toBe(ciphertext);
    const ack = (await a.client.waitFor((f) => f.type === "ack")) as { n: number };
    expect(ack.n).toBe(1);

    // Let any (buggy) echo arrive, then assert A never saw its own message.
    await sleep(100);
    expect(a.client.ofType("msg")).toHaveLength(0);

    // B -> A also works.
    const replyCiphertext = bytesToBase64Url(new Uint8Array(96).fill(4));
    b.client.send({ type: "msg", n: 1, c: replyCiphertext });
    const back = (await a.client.waitFor((f) => f.type === "msg")) as { c: string };
    expect(back.c).toBe(replyCiphertext);

    // Cleanup: explicit leave destroys the room.
    a.client.send({ type: "leave" });
    await b.client.waitFor((f) => f.type === "closed");
    expect(server.manager.size).toBe(before);
    a.client.close();
    b.client.close();
  });

  it("rejects a third client with the right token as room_full", async () => {
    const before = server.manager.size;
    const roomId = generateRoomId();
    const auth = makeAuth();
    const a = await joinRoom(port, roomId, auth);
    const b = await joinRoom(port, roomId, auth);

    const c = await Client.open(port, roomId);
    c.send({ type: "join", auth, peerId: generatePeerId() });
    const err = (await c.waitFor((f) => f.type === "err")) as { code: string };
    expect(err.code).toBe("room_full");

    a.client.send({ type: "leave" });
    await b.client.waitFor((f) => f.type === "closed");
    expect(server.manager.size).toBe(before);
    a.client.close();
    b.client.close();
    c.close();
  });

  it("rejects a wrong token with bad_auth", async () => {
    const before = server.manager.size;
    const roomId = generateRoomId();
    const auth = makeAuth();
    const a = await joinRoom(port, roomId, auth);

    const impostor = await Client.open(port, roomId);
    impostor.send({ type: "join", auth: makeAuth(9), peerId: generatePeerId() });
    const err = (await impostor.waitFor((f) => f.type === "err")) as { code: string };
    expect(err.code).toBe("bad_auth");

    // The room is untouched: a correct token can still take the second slot.
    const b = await joinRoom(port, roomId, auth);
    expect(b.client.ofType("joined")[0]!.peerLabel).toBe(a.label);

    a.client.send({ type: "leave" });
    await b.client.waitFor((f) => f.type === "closed");
    expect(server.manager.size).toBe(before);
    a.client.close();
    b.client.close();
    impostor.close();
  });

  it("destroys the room with peer_left when A leaves", async () => {
    const before = server.manager.size;
    const roomId = generateRoomId();
    const auth = makeAuth();
    const a = await joinRoom(port, roomId, auth);
    const b = await joinRoom(port, roomId, auth);

    a.client.send({ type: "leave" });
    const closed = (await b.client.waitFor((f) => f.type === "closed")) as { reason: string };
    expect(closed.reason).toBe("peer_left");
    expect(server.manager.size).toBe(before);

    a.client.close();
    b.client.close();
  });

  it("rejects a malformed room id with bad_room and creates nothing", async () => {
    const before = server.manager.size;
    const client = await Client.open(port, "not-a-room");
    client.send({ type: "join", auth: makeAuth(), peerId: generatePeerId() });
    const err = (await client.waitFor((f) => f.type === "err")) as { code: string };
    expect(err.code).toBe("bad_room");
    expect(server.manager.size).toBe(before);
    client.close();
  });

  it("rejects oversized raw frames with too_large without parsing them", async () => {
    const before = server.manager.size;
    const roomId = generateRoomId();
    const auth = makeAuth();
    const a = await joinRoom(port, roomId, auth);

    a.client.sendRaw("x".repeat(9000));
    const err = (await a.client.waitFor((f) => f.type === "err")) as { code: string };
    expect(err.code).toBe("too_large");

    a.client.send({ type: "leave" });
    await sleep(50);
    expect(server.manager.size).toBe(before);
    a.client.close();
  });

  it("holds no rooms in memory after everyone has left", async () => {
    // Every test above cleans up; nothing may linger.
    expect(server.manager.size).toBe(0);
  });
});
