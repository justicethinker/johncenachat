import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { generateRoomId, generateSecret } from "@aside/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Room } from "./Room";

// The relay under test, imported from source so no pre-build is required.
import { createAsideServer } from "../../server/src/server";

/**
 * A WebSocket shim over the platform WebSocket that:
 *  - rewrites the origin to the ephemeral test server
 *  - dispatches events inside React act() so state updates are flushed
 */
const NativeWebSocket = globalThis.WebSocket;
let testPort = 0;

class TestWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: TestWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readonly sentFrames: string[] = [];
  readonly receivedFrames: string[] = [];
  private readonly inner: WebSocket;

  constructor(url: string) {
    TestWebSocket.instances.push(this);
    const rewritten = url.replace(/^wss?:\/\/[^/]+/, `ws://127.0.0.1:${testPort}`);
    this.inner = new NativeWebSocket(rewritten);
    this.inner.onopen = () => act(() => this.onopen?.());
    this.inner.onmessage = (event) =>
      act(() => {
        this.receivedFrames.push(String(event.data));
        this.onmessage?.({ data: String(event.data) });
      });
    this.inner.onclose = () => act(() => this.onclose?.());
    this.inner.onerror = () => act(() => this.onerror?.());
  }

  get readyState(): number {
    return this.inner.readyState;
  }

  send(data: string): void {
    this.sentFrames.push(data);
    this.inner.send(data);
  }

  close(): void {
    try {
      this.inner.close();
    } catch {
      // Already closing.
    }
  }
}

function extractLabel(container: HTMLElement): string {
  const text = within(container).getByTestId("label").textContent ?? "";
  const match = /^You are (\d{4})$/.exec(text);
  if (!match) throw new Error(`unexpected label text: ${text}`);
  return match[1]!;
}

describe("two tabs against the real relay", () => {
  let server: {
    manager: { size: number };
    listen(port?: number): Promise<number>;
    close(): Promise<void>;
  };

  beforeAll(async () => {
    expect(typeof NativeWebSocket).toBe("function");
    vi.stubGlobal("WebSocket", TestWebSocket);
    const created = createAsideServer();
    testPort = await created.listen(0);
    server = created;
  });

  afterAll(async () => {
    await server.close();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cleanup();
    TestWebSocket.instances = [];
    document.querySelectorAll("[data-custom-container]").forEach((element) => element.remove());
    window.history.pushState(null, "", "/");
  });

  function makeContainer(): HTMLDivElement {
    const container = document.createElement("div");
    container.dataset.customContainer = "1";
    document.body.appendChild(container);
    return container;
  }

  async function openTwoTabs(vanish = true): Promise<{
    roomId: string;
    containerA: HTMLDivElement;
    containerB: HTMLDivElement;
    a: ReturnType<typeof render>;
    b: ReturnType<typeof render>;
  }> {
    const roomId = generateRoomId();
    const secret = generateSecret();
    const containerA = makeContainer();
    const containerB = makeContainer();

    window.history.pushState(null, "", `/r/${roomId}${vanish ? "" : "?vanish=0"}#${secret}`);
    const a = render(<Room roomId={roomId} />, { container: containerA });
    await within(containerA).findByTestId("waiting");

    window.history.pushState(null, "", `/r/${roomId}${vanish ? "" : "?vanish=0"}#${secret}`);
    const b = render(<Room roomId={roomId} />, { container: containerB });
    await within(containerB).findByRole("textbox"); // active: composer visible
    await waitFor(() =>
      expect(within(containerA).getByTestId("presence").className).toContain("presence-on"),
    );
    return { roomId, containerA, containerB, a, b };
  }

  it("honors vanish=0 and does not remove a departed member's messages", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    const containers = [makeContainer(), makeContainer(), makeContainer()];
    window.history.pushState(null, "", `/r/${roomId}?vanish=0#${secret}`);
    const host = render(<Room roomId={roomId} />, { container: containers[0] });
    await within(containers[0]!).findByTestId("waiting");
    window.history.pushState(null, "", `/r/${roomId}?vanish=0#${secret}`);
    const a = render(<Room roomId={roomId} />, { container: containers[1] });
    await within(containers[1]!).findByRole("textbox");
    window.history.pushState(null, "", `/r/${roomId}?vanish=0#${secret}`);
    const b = render(<Room roomId={roomId} />, { container: containers[2] });
    await within(containers[2]!).findByRole("textbox");

    fireEvent.change(within(containers[1]!).getByTestId("message-input"), {
      target: { value: "preserved from A" },
    });
    fireEvent.click(within(containers[1]!).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(within(containers[0]!).getByText("preserved from A")).toBeTruthy());
    expect(
      TestWebSocket.instances[0]!.receivedFrames.map((frame) => JSON.parse(frame)),
    ).toContainEqual(expect.objectContaining({ type: "joined", vanish: false }));
    a.unmount();
    await waitFor(() =>
      expect(within(containers[0]!).queryByText("preserved from A")).not.toBeNull(),
    );
    b.unmount();
    host.unmount();
  });

  it("receives server-stamped sender labels and never sees its own relayed frame", async () => {
    const { containerA, containerB, a, b } = await openTwoTabs();
    const aLabel = extractLabel(containerA);
    const bLabel = extractLabel(containerB);
    const input = within(containerA).getByTestId("message-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "stamped for B" } });
    fireEvent.click(within(containerA).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(within(containerB).getByText("stamped for B")).toBeTruthy());
    const sent = TestWebSocket.instances[0]!.sentFrames.map((frame) => JSON.parse(frame));
    const relayed = TestWebSocket.instances[1]!.receivedFrames.map((frame) =>
      JSON.parse(frame),
    ).find((frame) => frame.type === "msg");
    expect(sent.some((frame) => frame.type === "msg" && "from" in frame)).toBe(false);
    expect(relayed).toEqual(expect.objectContaining({ type: "msg", from: aLabel }));
    expect(relayed.from).not.toBe(bLabel);
    expect(
      TestWebSocket.instances[0]!.receivedFrames.map((frame) => JSON.parse(frame)),
    ).not.toContain(expect.objectContaining({ type: "msg" }));
    expect(within(containerA).queryByText("stamped for B")).toBeNull();
    a.unmount();
    b.unmount();
  });

  it("shows presence changes and ends with a clear message when one tab closes", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();

    const containerA = document.createElement("div");
    const containerB = document.createElement("div");
    document.body.append(containerA, containerB);

    // Tab A opens the link.
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    const a = render(<Room roomId={roomId} />, { container: containerA });
    await within(containerA).findByTestId("waiting");
    expect(window.location.hash).toBe("");
    const labelA = extractLabel(containerA);
    expect(labelA).toMatch(/^\d{4}$/);
    expect(within(containerA).getByTestId("presence").className).toContain("presence-off");

    // Tab B opens the same link (its own copy of the URL).
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    const b = render(<Room roomId={roomId} />, { container: containerB });
    await within(containerB).findByRole("textbox");
    const labelB = extractLabel(containerB);
    expect(labelB).toMatch(/^\d{4}$/);
    expect(labelB).not.toBe(labelA);

    // Both sides now see each other.
    expect(within(containerB).getByTestId("presence").className).toContain("presence-on");
    await waitFor(() =>
      expect(within(containerA).getByTestId("presence").className).toContain("presence-on"),
    );

    // Closing tab B ends tab A's chat with a clear message.
    expect(TestWebSocket.instances.length).toBe(2);
    b.unmount();
    await within(containerA).findByTestId("ended");
    expect(within(containerA).getByTestId("ended").textContent).toBe(
      "The other person left. This chat is closed.",
    );
    expect(server.manager.size).toBe(0);

    a.unmount();
    containerA.remove();
    containerB.remove();
  });

  it("vanishes only the departed sender's messages in a three-member room", async () => {
    const roomId = generateRoomId();
    const secret = generateSecret();
    const containers = [makeContainer(), makeContainer(), makeContainer()];
    // C creates; A and B join. A can leave without closing the room.
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    const c = render(<Room roomId={roomId} />, { container: containers[0] });
    await within(containers[0]!).findByTestId("waiting");
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    const a = render(<Room roomId={roomId} />, { container: containers[1] });
    await within(containers[1]!).findByRole("textbox");
    window.history.pushState(null, "", `/r/${roomId}#${secret}`);
    const b = render(<Room roomId={roomId} />, { container: containers[2] });
    await within(containers[2]!).findByRole("textbox");

    const sendFrom = (container: HTMLElement, text: string) => {
      fireEvent.change(within(container).getByTestId("message-input"), { target: { value: text } });
      fireEvent.click(within(container).getByRole("button", { name: "Send" }));
    };
    sendFrom(containers[1]!, "from A before leave");
    sendFrom(containers[2]!, "from B stays");
    await waitFor(() =>
      expect(within(containers[0]!).getByText("from A before leave")).toBeTruthy(),
    );
    await waitFor(() => expect(within(containers[0]!).getByText("from B stays")).toBeTruthy());

    a.unmount();
    await waitFor(() =>
      expect(within(containers[0]!).queryByText("from A before leave")).toBeNull(),
    );
    expect(within(containers[0]!).getByText("from B stays")).toBeTruthy();
    b.unmount();
    c.unmount();
  });

  it("shows only the other person's messages on each screen", async () => {
    const { containerA, containerB, b } = await openTwoTabs();
    const aLabel = extractLabel(containerA);
    const bLabel = extractLabel(containerB);

    // A sends: the input clears immediately and A never renders its own message.
    const inputA = within(containerA).getByTestId("message-input") as HTMLInputElement;
    fireEvent.change(inputA, { target: { value: "hello from A" } });
    fireEvent.click(within(containerA).getByRole("button", { name: "Send" }));
    expect(inputA.value).toBe("");

    await waitFor(() => expect(within(containerB).getByText("hello from A")).toBeTruthy());
    expect(within(containerA).queryByText("hello from A")).toBeNull();
    expect(within(containerA).getByTestId("messages").textContent).toBe("");

    // A gets a delivered tick after the ack.
    await waitFor(() =>
      expect(within(containerA).getByTestId("delivered-tick").className).toContain("tick-visible"),
    );

    // B replies.
    const inputB = within(containerB).getByTestId("message-input") as HTMLInputElement;
    fireEvent.change(inputB, { target: { value: "hi A, its B" } });
    fireEvent.click(within(containerB).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(within(containerA).getByText("hi A, its B")).toBeTruthy());
    expect(within(containerB).queryByText("hi A, its B")).toBeNull();

    // One-sided streams: each screen contains exactly the other person's text.
    // Each message sits under its sender's random label, never under our own.
    expect(within(containerA).getByTestId("messages").textContent).toBe(`${bLabel}hi A, its B`);
    expect(within(containerB).getByTestId("messages").textContent).toBe(`${aLabel}hello from A`);

    // Identical styling for every message; the only extra text is the sender label.
    const messageA = within(containerA).getByTestId("messages").querySelector(".message");
    const messageB = within(containerB).getByTestId("messages").querySelector(".message");
    expect(messageA?.className).toBe("message");
    expect(messageB?.className).toBe("message");

    b.unmount();
  });
});
