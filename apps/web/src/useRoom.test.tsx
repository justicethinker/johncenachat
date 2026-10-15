import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  decryptMessage,
  deriveKeys,
  encryptMessage,
  generateMessageId,
  generateRoomId,
  generateSecret,
} from "@aside/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Room } from "./Room";
import { type RoomApi, useRoom } from "./useRoom";

/**
 * Mock WebSocket driving the connection state machine without a server.
 */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static latest(): MockWebSocket {
    const instance = MockWebSocket.instances.at(-1);
    if (!instance) throw new Error("no WebSocket constructed yet");
    return instance;
  }
  static reset(): void {
    MockWebSocket.instances = [];
  }

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("not open");
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  /** Test helpers. */
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  message(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

let harnessApi: RoomApi | null = null;

function Harness({ roomId }: { roomId: string }) {
  harnessApi = useRoom(roomId);
  return null;
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function joinFlow(roomId: string, secret: string): Promise<MockWebSocket> {
  window.history.pushState(null, "", `/r/${roomId}#${secret}`);
  render(<Harness roomId={roomId} />);
  await until(() => MockWebSocket.instances.length === 1);
  const socket = MockWebSocket.latest();
  act(() => {
    socket.open();
  });
  await until(() => socket.sent.length === 1);
  act(() => {
    socket.message({
      type: "joined",
      label: "4821",
      members: [],
      cap: 8,
      locked: false,
      isCreator: true,
      vanish: true,
    });
  });

  await until(() => harnessApi !== null && harnessApi.status === "waiting");
  return socket;
}

beforeEach(() => {
  harnessApi = null;
  MockWebSocket.reset();
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.history.pushState(null, "", "/");
});

describe("useRoom connection state machine", () => {
  it("reads the secret, strips the fragment, and joins with the derived auth token", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);

    render(<Room roomId={roomId} />);
    // Fragment is gone from the URL bar immediately after mount.
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe(`/r/${roomId}`);

    await until(() => MockWebSocket.instances.length === 1);
    const socket = MockWebSocket.latest();
    expect(socket.url).toBe(
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/${roomId}`,
    );

    act(() => {
      socket.open();
    });
    await until(() => socket.sent.length === 1);
    const join = JSON.parse(socket.sent[0]!) as { type: string; auth: string; peerId: string };
    expect(join.type).toBe("join");
    expect(join.peerId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(join).not.toHaveProperty("from");
    const { authToken } = await deriveKeys(secret);
    expect(join.auth).toBe(authToken);
  });

  it("connects to VITE_RELAY_WS when set, ignoring the page origin", async () => {
    vi.stubEnv("VITE_RELAY_WS", "wss://relay.example.com/");
    const roomId = generateRoomId();
    const secret = generateSecret();
    await joinFlow(roomId, secret);
    expect(MockWebSocket.latest().url).toBe(`wss://relay.example.com/ws/${roomId}`);
  });

  it("moves through waiting, active and back, then ends with a clear message", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    render(<Room roomId={roomId} />);

    await until(() => MockWebSocket.instances.length === 1);
    const socket = MockWebSocket.latest();
    act(() => {
      socket.open();
    });
    await until(() => socket.sent.length === 1);

    act(() => {
      socket.message({
        type: "joined",
        label: "4821",
        members: [],
        cap: 8,
        locked: false,
        isCreator: true,
        vanish: true,
      });
    });
    await until(() => screen.queryByTestId("waiting") !== null);
    expect(screen.getByTestId("label").textContent).toBe("You are 4821");
    expect(screen.getByTestId("presence").className).toContain("presence-off");

    act(() => {
      socket.message({ type: "peer", state: "joined", label: "0377", count: 2 });
    });
    await until(() => screen.getByTestId("presence").className.includes("presence-on"));
    expect(screen.queryByTestId("waiting")).toBeNull();

    act(() => {
      socket.message({ type: "peer", state: "away", label: "0377", count: 1 });
    });
    await until(() => screen.getByTestId("presence").className.includes("presence-off"));
    expect(screen.queryByTestId("waiting")).not.toBeNull();

    act(() => {
      socket.message({ type: "closed", reason: "peer_left" });
    });
    await until(() => screen.queryByTestId("ended") !== null);
    expect(screen.getByTestId("ended").textContent).toBe(
      "The other person left. This chat is closed.",
    );
    // No reconnect after the room was destroyed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("shows the incomplete screen when the fragment is missing", () => {
    const roomId = generateRoomId();
    window.history.pushState(null, "", `/r/${roomId}`);
    render(<Room roomId={roomId} />);
    expect(screen.getByTestId("incomplete").textContent).toBe("This link is incomplete");
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("shows the incomplete screen for a malformed room id and still strips the url", () => {
    window.history.pushState(null, "", `/r/nope#secretnotvalid`);
    render(<Room roomId="nope" />);
    expect(screen.getByTestId("incomplete")).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("reconnects with the same peerId after a drop", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    render(<Harness roomId={roomId} />);

    await until(() => MockWebSocket.instances.length === 1);
    const first = MockWebSocket.latest();
    act(() => {
      first.open();
    });
    await until(() => first.sent.length === 1);
    const firstJoin = JSON.parse(first.sent[0]!) as { peerId: string };
    act(() => {
      first.message({
        type: "joined",
        label: "4821",
        members: [],
        cap: 8,
        locked: false,
        isCreator: true,
        vanish: true,
      });
    });

    // From here on, control time so the reconnect delay runs instantly.
    vi.useFakeTimers();
    // Socket drops: the room enters "connecting" and retries after 1s.
    act(() => {
      first.drop();
    });
    expect(harnessApi!.status).toBe("connecting");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(MockWebSocket.instances).toHaveLength(2);

    const second = MockWebSocket.latest();
    act(() => {
      second.open();
    });
    await until(() => second.sent.length === 1);
    const secondJoin = JSON.parse(second.sent[0]!) as { peerId: string };
    expect(secondJoin.peerId).toBe(firstJoin.peerId);

    act(() => {
      second.message({
        type: "joined",
        label: "4821",
        members: ["0377"],
        cap: 8,
        locked: false,
        isCreator: true,
        vanish: true,
      });
    });
    expect(harnessApi!.status).toBe("active");
    expect(harnessApi!.label).toBe("4821");
  });

  it("ends with reconnect_failed once the grace window runs out", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    render(<Harness roomId={roomId} />);

    await until(() => MockWebSocket.instances.length === 1);
    const first = MockWebSocket.latest();
    act(() => {
      first.open();
    });
    await until(() => first.sent.length === 1);
    act(() => {
      first.message({
        type: "joined",
        label: "4821",
        members: [],
        cap: 8,
        locked: false,
        isCreator: true,
        vanish: true,
      });
    });

    vi.useFakeTimers();
    act(() => {
      first.drop();
    });
    for (let i = 0; i < 60 && harnessApi!.status !== "ended"; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      const instance = MockWebSocket.latest();
      if (instance.readyState === MockWebSocket.CONNECTING) {
        act(() => {
          instance.drop();
        });
      }
    }
    expect(harnessApi!.status).toBe("ended");
    expect(harnessApi!.endReason).toBe("reconnect_failed");
  });

  it("encrypts outgoing messages, tracks sent ids and never stores own messages", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    const socket = await joinFlow(roomId, secret);

    act(() => {
      socket.message({ type: "peer", state: "joined", label: "0377", count: 2 });
    });
    await until(() => harnessApi!.status === "active");

    expect(harnessApi!.sendMessage("hello there")).toBe(true);
    await until(() => socket.sent.length === 2);
    const frame = JSON.parse(socket.sent[1]!) as { type: string; n: number; c: string };
    expect(frame.type).toBe("msg");

    const { encKey } = await deriveKeys(secret);
    const payload = await decryptMessage(frame.c, encKey, roomId);
    expect(payload.text).toBe("hello there");
    expect(harnessApi!.sentIds.has(payload.id)).toBe(true);
    // One-sided view: the sender never stores or renders its own message.
    expect(harnessApi!.messages).toHaveLength(0);

    // Rejected sends are not queued.
    expect(harnessApi!.sendMessage("")).toBe(false);
    expect(harnessApi!.sendMessage("a".repeat(1501))).toBe(false);

    // Ack flips the delivered tick.
    act(() => {
      socket.message({ type: "ack", n: frame.n });
    });
    expect(harnessApi!.delivered).toBe(true);

    // Replayed message ids are dropped.
    const duplicate = await encryptMessage(
      { id: generateMessageId(), text: "first" },
      encKey,
      roomId,
    );
    act(() => {
      socket.message({ type: "msg", from: "0000", c: duplicate });
    });
    await until(() => harnessApi!.messages.length === 1);
    const duplicateAgain = await encryptMessage(
      { id: harnessApi!.messages[0]!.id, text: "first again" },
      encKey,
      roomId,
    );
    act(() => {
      socket.message({ type: "msg", from: "0000", c: duplicateAgain });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(harnessApi!.messages).toHaveLength(1);

    // A fresh incoming message is decrypted and stored.
    const fresh = await encryptMessage(
      { id: generateMessageId(), text: "their message" },
      encKey,
      roomId,
    );
    act(() => {
      socket.message({ type: "msg", from: "0000", c: fresh });
    });
    await until(() => harnessApi!.messages.length === 2);
    expect(harnessApi!.messages[1]!.text).toBe("their message");

    // Replies carry `re` in the encrypted payload.
    const repliedTo = harnessApi!.messages[0]!.id;
    expect(harnessApi!.sendMessage("follow-up", repliedTo)).toBe(true);
    await until(() => socket.sent.length === 3);
    const replyFrame = JSON.parse(socket.sent[2]!) as { type: string; c: string };
    const replyPayload = await decryptMessage(replyFrame.c, encKey, roomId);
    expect(replyPayload.text).toBe("follow-up");
    expect(replyPayload.re).toBe(repliedTo);
    // Still one-sided: nothing the sender said is ever stored.
    expect(harnessApi!.messages).toHaveLength(2);
  });

  it("clears the input on send and shows a delivered tick that fades", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    render(<Room roomId={roomId} />);

    await until(() => MockWebSocket.instances.length === 1);
    const socket = MockWebSocket.latest();
    act(() => {
      socket.open();
    });
    await until(() => socket.sent.length === 1);
    act(() => {
      socket.message({
        type: "joined",
        label: "4821",
        members: ["0377"],
        cap: 2,
        locked: false,
        isCreator: true,
        vanish: true,
      });
    });
    await until(() => screen.queryByTestId("message-input") !== null);

    fireEvent.change(screen.getByTestId("message-input"), { target: { value: "ping" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // Clears immediately on send.
    expect((screen.getByTestId("message-input") as HTMLInputElement).value).toBe("");

    await until(() => socket.sent.length === 2);
    const frame = JSON.parse(socket.sent[1]!) as { type: string; n: number };
    expect(frame.type).toBe("msg");

    act(() => {
      socket.message({ type: "ack", n: frame.n });
    });
    await until(() => screen.getByTestId("delivered-tick").className.includes("tick-visible"));

    // Fades after about 1.2 seconds.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    expect(screen.getByTestId("delivered-tick").className).not.toContain("tick-visible");
  });

  it("ends the chat locally when the user clicks End chat", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    render(<Room roomId={roomId} />);

    await until(() => MockWebSocket.instances.length === 1);
    const socket = MockWebSocket.latest();
    act(() => {
      socket.open();
    });
    await until(() => socket.sent.length === 1);
    act(() => {
      socket.message({
        type: "joined",
        label: "4821",
        members: ["0377"],
        cap: 2,
        locked: false,
        isCreator: true,
        vanish: true,
      });
    });
    await until(() => screen.queryByTestId("message-input") !== null);

    fireEvent.click(screen.getByTestId("end-chat"));
    await until(() => screen.queryByTestId("ended") !== null);
    expect(screen.getByTestId("ended").textContent).toBe("You ended this chat.");

    // The server is told to destroy the room for both people.
    const leave = JSON.parse(socket.sent[1]!) as { type: string };
    expect(leave.type).toBe("leave");

    // The late `closed` frame from the server must not override the local
    // end state, and a dropped socket must not trigger a reconnect.
    act(() => {
      socket.message({ type: "closed", reason: "peer_left" });
      socket.drop();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByTestId("ended").textContent).toBe("You ended this chat.");
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("links back to the landing page from the ended screen", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    render(<Room roomId={roomId} />);
    await until(() => MockWebSocket.instances.length === 1);
    const socket = MockWebSocket.latest();
    act(() => {
      socket.open();
    });
    await until(() => socket.sent.length === 1);
    act(() => {
      socket.message({ type: "closed", reason: "expired" });
      socket.drop();
    });
    await until(() => screen.queryByTestId("ended") !== null);

    // The title is a link home, alongside the primary button.
    fireEvent.click(screen.getByRole("link", { name: "Aside home" }));
    expect(window.location.pathname).toBe("/");
  });

  it("shows the room's close reason when the link's room is already gone", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    render(<Room roomId={roomId} />);

    await until(() => MockWebSocket.instances.length === 1);
    const socket = MockWebSocket.latest();
    act(() => {
      socket.open();
    });
    await until(() => socket.sent.length === 1);

    // Dead link: server answers `closed` instead of `joined`, then drops us.
    act(() => {
      socket.message({ type: "closed", reason: "expired" });
      socket.drop();
    });
    await until(() => screen.queryByTestId("ended") !== null);
    expect(screen.getByTestId("ended").textContent).toBe(
      "This chat reached its time limit and was closed.",
    );
    // No reconnect loop against a dead link.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("sends the group size from the link on join, and drops out-of-range sizes", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}?cap=3#${secret}`);
    render(<Harness roomId={roomId} />);
    await until(() => MockWebSocket.instances.length === 1);
    const socket = MockWebSocket.latest();
    act(() => {
      socket.open();
    });
    await until(() => socket.sent.length === 1);
    expect((JSON.parse(socket.sent[0]!) as { cap?: number }).cap).toBe(3);
    // Only the fragment is stripped; the query stays readable.
    expect(window.location.search).toBe("?cap=3");
    expect(window.location.hash).toBe("");

    const tooBig = generateRoomId();
    cleanup();
    cleanup();
    window.history.pushState(null, "", `/r/${tooBig}?cap=9#${secret}`);
    render(<Harness roomId={tooBig} />);
    await until(() => MockWebSocket.instances.length === 2);
    const second = MockWebSocket.latest();
    act(() => {
      second.open();
    });
    await until(() => second.sent.length === 1);
    expect(JSON.parse(second.sent[0]!)).not.toHaveProperty("cap");
  });

  it("sends the room vanish choice with the creator join and round-trips it", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}?vanish=0#${secret}`);
    render(<Harness roomId={roomId} />);
    await until(() => MockWebSocket.instances.length === 1);
    const socket = MockWebSocket.latest();
    act(() => socket.open());
    await until(() => socket.sent.length === 1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "join", vanish: false });
    act(() => {
      socket.message({
        type: "joined",
        label: "4821",
        members: [],
        cap: 4,
        locked: false,
        isCreator: true,
        vanish: false,
      });
    });
    await until(() => harnessApi!.status === "waiting");
    expect(harnessApi!.vanish).toBe(false);
  });

  it("removes only a departed sender's messages; away and back preserve them", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    const socket = await joinFlow(roomId, secret);
    const { encKey } = await deriveKeys(secret);
    act(() => {
      socket.message({ type: "peer", state: "joined", label: "1111", count: 2 });
      socket.message({ type: "peer", state: "joined", label: "2222", count: 3 });
    });
    await until(() => harnessApi!.members.length === 2);

    async function deliver(from: string, text: string): Promise<void> {
      const c = await encryptMessage({ id: generateMessageId(), text }, encKey, roomId);
      act(() => socket.message({ type: "msg", from, c }));
      await until(() => harnessApi!.messages.some((message) => message.text === text));
    }

    await deliver("1111", "vanishing one");
    await deliver("2222", "keep this");
    await deliver("1111", "vanishing two");

    act(() => socket.message({ type: "peer", state: "away", label: "1111", count: 2 }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(harnessApi!.messages).toHaveLength(3);

    act(() => socket.message({ type: "peer", state: "back", label: "1111", count: 3 }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(harnessApi!.messages).toHaveLength(3);

    // This is the same `left` frame the relay sends when reconnect grace expires.
    act(() => socket.message({ type: "peer", state: "left", label: "1111", count: 2 }));
    await until(() => harnessApi!.messages.length === 1);
    expect(harnessApi!.messages.map((message) => message.text)).toEqual(["keep this"]);
    expect(harnessApi!.messages[0]!.from).toBe("2222");
  });

  it("clears a departed sender's text so a reply falls back to the earlier-message chip", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    render(<Room roomId={roomId} />);
    await until(() => MockWebSocket.instances.length === 1);
    const socket = MockWebSocket.latest();
    act(() => socket.open());
    await until(() => socket.sent.length === 1);
    act(() => {
      socket.message({
        type: "joined",
        label: "4821",
        members: ["1111", "2222"],
        cap: 4,
        locked: false,
        isCreator: true,
        vanish: true,
      });
    });
    await until(() => screen.queryByTestId("message-input") !== null);
    const { encKey } = await deriveKeys(secret);
    const originalId = generateMessageId();
    const original = await encryptMessage(
      { id: originalId, text: "quoted secret" },
      encKey,
      roomId,
    );
    const reply = await encryptMessage(
      { id: generateMessageId(), text: "reply remains", re: originalId },
      encKey,
      roomId,
    );
    act(() => socket.message({ type: "msg", from: "1111", c: original }));
    await until(() => screen.queryByText("quoted secret") !== null);
    act(() => socket.message({ type: "msg", from: "2222", c: reply }));
    await until(
      () => screen.getByTestId("messages").textContent?.includes("reply remains") === true,
    );
    expect(screen.getByTestId("reply-quote").textContent).toBe("quoted secret");

    act(() => socket.message({ type: "peer", state: "left", label: "1111", count: 2 }));
    await until(() => screen.queryByText("quoted secret") === null);
    expect(screen.getByText("reply remains")).toBeTruthy();
    expect(screen.getByTestId("reply-generic").textContent).toBe("replying to an earlier message");
  });

  it("does not remove messages after left when vanish is disabled", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}?vanish=0#${secret}`);
    render(<Harness roomId={roomId} />);
    await until(() => MockWebSocket.instances.length === 1);
    const socket = MockWebSocket.latest();
    act(() => socket.open());
    await until(() => socket.sent.length === 1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "join", vanish: false });
    act(() => {
      socket.message({
        type: "joined",
        label: "4821",
        members: [],
        cap: 8,
        locked: false,
        isCreator: true,
        vanish: false,
      });
      socket.message({ type: "peer", state: "joined", label: "1111", count: 2 });
    });
    await until(() => harnessApi!.vanish === false && harnessApi!.status === "active");
    const { encKey } = await deriveKeys(secret);
    const c = await encryptMessage(
      { id: generateMessageId(), text: "keep on screen" },
      encKey,
      roomId,
    );
    act(() => socket.message({ type: "msg", from: "1111", c }));
    await until(() => harnessApi!.messages.length === 1);
    act(() => socket.message({ type: "peer", state: "left", label: "1111", count: 1 }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(harnessApi!.messages.map((message) => message.text)).toEqual(["keep on screen"]);
  });

  it("keeps the server-stamped sender label on each received message", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    const socket = await joinFlow(roomId, secret);
    const { encKey } = await deriveKeys(secret);
    const c = await encryptMessage(
      { id: generateMessageId(), text: "from the group" },
      encKey,
      roomId,
    );
    act(() => {
      socket.message({ type: "msg", from: "7351", c });
    });
    await until(() => harnessApi!.messages.length === 1);
    expect(harnessApi!.messages[0]!.from).toBe("7351");
    expect(harnessApi!.messages[0]!.text).toBe("from the group");
  });

  it("lets the creator lock the room, and the lock reaches everyone", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    const socket = await joinFlow(roomId, secret);
    expect(harnessApi!.isCreator).toBe(true);
    expect(harnessApi!.locked).toBe(false);

    act(() => {
      harnessApi!.lock();
    });
    await until(() => socket.sent.length === 2);
    expect(JSON.parse(socket.sent[1]!)).toEqual({ type: "lock" });

    act(() => {
      socket.message({ type: "locked" });
    });
    await until(() => harnessApi!.locked);
  });

  it("shows the lock control only to the creator, with the group count", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    render(<Room roomId={roomId} />);
    await until(() => MockWebSocket.instances.length === 1);
    const socket = MockWebSocket.latest();
    act(() => {
      socket.open();
    });
    await until(() => socket.sent.length === 1);
    act(() => {
      socket.message({
        type: "joined",
        label: "4821",
        members: ["0377"],
        cap: 3,
        locked: false,
        isCreator: false,
        vanish: true,
      });
    });
    await until(() => screen.queryByTestId("message-input") !== null);
    expect(screen.queryByTestId("lock-room")).toBeNull();
    expect(screen.queryByTestId("host-tag")).toBeNull();
    expect(screen.getByTestId("members").textContent).toContain("2 of 3 here");
    expect(screen.getAllByTestId("member").map((member) => member.textContent)).toEqual(["0377"]);
  });

  it("shows the creator a working lock button that reads Locked afterwards", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    render(<Room roomId={roomId} />);
    await until(() => MockWebSocket.instances.length === 1);
    const socket = MockWebSocket.latest();
    act(() => {
      socket.open();
    });
    await until(() => socket.sent.length === 1);
    act(() => {
      socket.message({
        type: "joined",
        label: "4821",
        members: [],
        cap: 8,
        locked: false,
        isCreator: true,
        vanish: true,
      });
    });
    await until(() => screen.queryByTestId("lock-room") !== null);
    expect(screen.getByTestId("host-tag").textContent).toBe("Host");

    fireEvent.click(screen.getByTestId("lock-room"));
    await until(() => socket.sent.length === 2);
    expect(JSON.parse(socket.sent[1]!)).toEqual({ type: "lock" });

    act(() => {
      socket.message({ type: "locked" });
    });
    await until(() => screen.getByTestId("lock-room").textContent === "Locked");
    expect((screen.getByTestId("lock-room") as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces join errors as an ended state", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    render(<Room roomId={roomId} />);
    await until(() => MockWebSocket.instances.length === 1);
    const socket = MockWebSocket.latest();
    act(() => {
      socket.open();
    });
    await until(() => socket.sent.length === 1);
    act(() => {
      socket.message({ type: "err", code: "room_full" });
    });
    await until(() => screen.queryByTestId("ended") !== null);
    expect(screen.getByTestId("ended").textContent).toBe("This room is full or closed.");
  });
});
