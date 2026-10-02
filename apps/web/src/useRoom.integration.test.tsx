import { act, cleanup, render, waitFor, within } from "@testing-library/react";
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
    window.history.pushState(null, "", "/");
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
    await within(containerB).findByTestId("active-placeholder");
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
});
