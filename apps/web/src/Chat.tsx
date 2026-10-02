import { MAX_TEXT_LENGTH } from "@aside/protocol";
import { useEffect, useRef, useState } from "react";
import type { RoomApi } from "./useRoom";

const TICK_VISIBLE_MS = 1200;

/**
 * One-sided chat UI (spec section 8): the list shows only received
 * messages, all identical in style — no names, no timestamps, no own
 * bubbles. The input clears immediately on send; after an ack a small
 * "delivered" tick appears and fades after ~1.2s.
 */
export function Chat({ room }: { room: RoomApi }) {
  const [draft, setDraft] = useState("");
  const [tickVisible, setTickVisible] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Follow the newest received message.
  useEffect(() => {
    const element = listRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [room.messages.length]);

  useEffect(() => {
    if (!room.delivered) {
      setTickVisible(false);
      return;
    }
    setTickVisible(true);
    const timer = setTimeout(() => setTickVisible(false), TICK_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [room.delivered]);

  function send(): void {
    const text = draft;
    if (text.length === 0) return;
    if (room.sendMessage(text)) {
      setDraft(""); // clears immediately on send
    }
  }

  return (
    <>
      <div className="messages" ref={listRef} data-testid="messages">
        {room.messages.map((message) => (
          <div className="message" key={message.id}>
            {message.text}
          </div>
        ))}
      </div>

      {room.status === "active" && (
        <div className="composer">
          <input
            className="input"
            type="text"
            value={draft}
            maxLength={MAX_TEXT_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                send();
              }
            }}
            aria-label="Message"
            data-testid="message-input"
          />
          <button
            type="button"
            className="btn btn-primary send"
            onClick={send}
            disabled={draft.length === 0}
          >
            Send
          </button>
          <span
            className={tickVisible ? "tick tick-visible" : "tick"}
            data-testid="delivered-tick"
            aria-hidden="true"
          >
            ✓
          </span>
        </div>
      )}
    </>
  );
}
