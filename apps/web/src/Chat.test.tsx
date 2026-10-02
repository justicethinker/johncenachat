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
    endReason: null,
    lastError: null,
    messages: [],
    delivered: false,
    sendMessage: vi.fn(() => true),
    clearError: vi.fn(),
    sentIds: new Set<string>(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("reply", () => {
  it("clicking a received message reveals Reply; choosing it puts a quote chip in the composer", () => {
    const room = makeRoom({ messages: [{ id: "r1", text: "the question" }] });
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
    const room = makeRoom({ messages: [{ id: "r1", text: "the question" }] });
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
    const room = makeRoom({ messages: [{ id: "r1", text: "hold me" }] });
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
      messages: [{ id: "m1", text: "the answer is four", re: "own1" }],
    });
    render(<Chat room={room} />);

    const generic = screen.getByTestId("reply-generic");
    expect(generic.textContent).toBe("replying to something you said");
    expect(screen.queryByTestId("reply-quote")).toBeNull();
    // Nothing else from that exchange is rendered: no quoted text anywhere.
    expect(screen.getByTestId("messages").textContent).toBe(
      "replying to something you saidthe answer is four",
    );
  });

  it("re pointing to a received message shows the quoted text", () => {
    const room = makeRoom({
      messages: [
        { id: "r1", text: "original question" },
        { id: "r2", text: "here is my answer", re: "r1" },
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
    const room = makeRoom({ messages: [{ id: "m1", text: "orphan reply", re: "mystery" }] });
    render(<Chat room={room} />);
    expect(screen.getByTestId("reply-generic")).toBeTruthy();
    expect(screen.queryByTestId("reply-quote")).toBeNull();
  });
});
