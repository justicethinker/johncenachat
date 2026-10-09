import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "./Chat";
import type { RoomApi } from "./useRoom";

function makeRoom(overrides: Partial<RoomApi> = {}): RoomApi {
  return {
    status: "active",
    label: "4821",
    peerLabel: "0377",
    peerPresent: true,
    members: [{ label: "0377", present: true }],
    cap: 2,
    isCreator: false,
    locked: false,
    endReason: null,
    lastError: null,
    messages: [],
    delivered: false,
    sendMessage: vi.fn(() => true),
    clearError: vi.fn(),
    endChat: vi.fn(),
    lock: vi.fn(),
    sentIds: new Set<string>(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "hidden");
  Reflect.deleteProperty(document, "hasFocus");
});

describe("sender labels", () => {
  it("shows one label per run of messages from the same sender", () => {
    const room = makeRoom({
      messages: [
        { id: "g1", from: "1111", text: "one" },
        { id: "g2", from: "1111", text: "two" },
        { id: "g3", from: "2222", text: "three" },
        { id: "g4", from: "1111", text: "four" },
      ],
    });
    render(<Chat room={room} />);

    const labels = screen.getAllByTestId("message-label").map((element) => element.textContent);
    expect(labels).toEqual(["1111", "2222", "1111"]);
    expect(screen.getByTestId("messages").textContent).toBe("1111onetwo2222three1111four");
  });
});

describe("reply", () => {
  it("clicking a received message reveals Reply; choosing it puts a quote chip in the composer", () => {
    const room = makeRoom({ messages: [{ id: "r1", from: "0377", text: "the question" }] });
    render(<Chat room={room} />);

    fireEvent.click(screen.getByText("the question"));
    fireEvent.click(screen.getByTestId("reply-option"));

    // Composer shows the quote chip with a cancel button.
    const chip = screen.getByTestId("reply-chip");
    expect(chip.textContent).toContain("the question");

    fireEvent.change(screen.getByTestId("message-input"), { target: { value: "the answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(room.sendMessage).toHaveBeenCalledWith("the answer", "r1");
    expect((screen.getByTestId("message-input") as HTMLInputElement).value).toBe("");
    expect(screen.queryByTestId("reply-chip")).toBeNull();
  });

  it("the cancel button clears the reply before sending", () => {
    const room = makeRoom({ messages: [{ id: "r1", from: "0377", text: "the question" }] });
    render(<Chat room={room} />);

    fireEvent.click(screen.getByText("the question"));
    fireEvent.click(screen.getByTestId("reply-option"));
    expect(screen.getByTestId("reply-chip")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));
    expect(screen.queryByTestId("reply-chip")).toBeNull();

    fireEvent.change(screen.getByTestId("message-input"), { target: { value: "no reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(room.sendMessage).toHaveBeenCalledWith("no reply");
  });

  it("long-pressing a received message reveals Reply", () => {
    vi.useFakeTimers();
    const room = makeRoom({ messages: [{ id: "r1", from: "0377", text: "hold me" }] });
    render(<Chat room={room} />);

    fireEvent.pointerDown(screen.getByText("hold me"));
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(screen.queryByTestId("reply-option")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("reply-option")).toBeTruthy();

    // The follow-up click from a long-press must not toggle it away.
    fireEvent.click(screen.getByText("hold me"));
    expect(screen.getByTestId("reply-option")).toBeTruthy();
  });
});

describe("incoming reply rendering", () => {
  it("re pointing to a message this screen sent shows the generic chip with no quoted text", () => {
    // sentIds holds ids of messages *we* sent (kept in memory only).
    const room = makeRoom({
      sentIds: new Set(["own1"]),
      messages: [{ id: "m1", from: "0377", text: "the answer is four", re: "own1" }],
    });
    render(<Chat room={room} />);

    const generic = screen.getByTestId("reply-generic");
    expect(generic.textContent).toBe("replying to something you said");
    expect(screen.queryByTestId("reply-quote")).toBeNull();
    // Nothing else from that exchange is rendered: no quoted text anywhere.
    expect(screen.getByTestId("messages").textContent).toBe(
      "0377replying to something you saidthe answer is four",
    );
  });

  it("re pointing to a received message shows the quoted text", () => {
    const room = makeRoom({
      messages: [
        { id: "r1", from: "0377", text: "original question" },
        { id: "r2", from: "0377", text: "here is my answer", re: "r1" },
      ],
    });
    render(<Chat room={room} />);

    const quote = screen.getByTestId("reply-quote");
    expect(quote.textContent).toBe("original question");
    expect(screen.queryByTestId("reply-generic")).toBeNull();
    expect(screen.getByText("here is my answer")).toBeTruthy();
    // Shown twice: as the original message and as the quoted text.
    expect(screen.getAllByText("original question")).toHaveLength(2);
  });

  it("re pointing at an unknown id never quotes text", () => {
    const room = makeRoom({
      messages: [{ id: "m1", from: "0377", text: "orphan reply", re: "mystery" }],
    });
    render(<Chat room={room} />);
    expect(screen.getByTestId("reply-generic")).toBeTruthy();
    expect(screen.queryByTestId("reply-quote")).toBeNull();
  });
});

describe("privacy: blur behind Tap to reveal", () => {
  it("blurs the list when the tab becomes hidden and reveals on tap", () => {
    const room = makeRoom({ messages: [{ id: "r1", from: "0377", text: "secret words" }] });
    render(<Chat room={room} />);
    expect(screen.queryByTestId("tap-to-reveal")).toBeNull();
    expect(screen.getByTestId("messages").className).not.toContain("message-blurred");

    // The tab is hidden.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(screen.getByTestId("tap-to-reveal").textContent).toBe("Tap to reveal");
    expect(screen.getByTestId("messages").className).toContain("message-blurred");

    fireEvent.click(screen.getByTestId("tap-to-reveal"));
    expect(screen.queryByTestId("tap-to-reveal")).toBeNull();
    expect(screen.getByTestId("messages").className).not.toContain("message-blurred");
  });

  it("blurs the list when the window loses focus", () => {
    const room = makeRoom({ messages: [{ id: "r1", from: "0377", text: "secret words" }] });
    render(<Chat room={room} />);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.getByTestId("tap-to-reveal")).toBeTruthy();
    expect(screen.getByTestId("messages").className).toContain("message-blurred");

    // Regaining focus hides the overlay again.
    Reflect.deleteProperty(document, "hasFocus");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.queryByTestId("tap-to-reveal")).toBeNull();
    expect(screen.getByTestId("messages").className).not.toContain("message-blurred");
  });
});
