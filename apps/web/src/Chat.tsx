import { MAX_TEXT_LENGTH } from "@aside/protocol";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { type ReceivedMessage, type RoomApi } from "./useRoom";

const TICK_VISIBLE_MS = 1200;
const LONG_PRESS_MS = 500;

/**
 * One-sided chat UI (spec section 8): the list shows only received
 * messages, all identical in style — no names, no timestamps, no own
 * bubbles. The input clears immediately on send; after an ack a small
 * "delivered" tick appears and fades after ~1.2s.
 *
 * Reply (spec step 7): click or long-press a received message to reveal
 * Reply; the composer shows a quote chip with a cancel button. Outgoing
 * payloads carry `re`. Incoming replies to something *this screen* sent
 * render as a generic chip with no quoted text.
 */
export function Chat({ room }: { room: RoomApi }) {
  const [draft, setDraft] = useState("");
  const [tickVisible, setTickVisible] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ReceivedMessage | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);

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

  useEffect(() => {
    return () => {
      if (longPressTimer.current !== null) {
        clearTimeout(longPressTimer.current);
      }
    };
  }, []);

  function cancelLongPress(): void {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function beginLongPress(id: string): void {
    cancelLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      suppressClickRef.current = true;
      setSelectedId(id);
    }, LONG_PRESS_MS);
  }

  function onMessageClick(id: string): void {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setSelectedId(id);
  }

  function chooseReply(message: ReceivedMessage, event: MouseEvent): void {
    event.stopPropagation();
    cancelLongPress();
    setReplyTo(message);
    setSelectedId(null);
  }

  function send(): void {
    const text = draft;
    if (text.length === 0) return;
    const re = replyTo?.id;
    const accepted = re !== undefined ? room.sendMessage(text, re) : room.sendMessage(text);
    if (accepted) {
      setDraft(""); // clears immediately on send
      setReplyTo(null);
    }
  }

  return (
    <>
      <div className="messages" ref={listRef} data-testid="messages">
        {room.messages.map((message) => (
          <div
            className="message"
            key={message.id}
            onClick={() => onMessageClick(message.id)}
            onPointerDown={() => beginLongPress(message.id)}
            onPointerUp={cancelLongPress}
            onPointerLeave={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onContextMenu={(event) => event.preventDefault()}
          >
            {selectedId === message.id && (
              <button
                type="button"
                className="reply-option"
                data-testid="reply-option"
                onClick={(event) => chooseReply(message, event)}
              >
                Reply
              </button>
            )}
            {message.re !== undefined && <ReplyIndicator room={room} re={message.re} />}
            <span className="message-text">{message.text}</span>
          </div>
        ))}
      </div>

      {room.status === "active" && (
        <div className="composer-wrap">
          {replyTo !== null && (
            <div className="reply-chip" data-testid="reply-chip">
              <span className="reply-chip-text">{replyTo.text}</span>
              <button
                type="button"
                className="reply-cancel"
                aria-label="Cancel reply"
                onClick={() => setReplyTo(null)}
              >
                ×
              </button>
            </div>
          )}
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
        </div>
      )}
    </>
  );
}

/**
 * A received message that replies to something:
 *  - a message this screen sent -> generic chip, never quoted text
 *  - a message this screen received -> the quoted text
 *  - unknown id -> generic chip (never quote unattributable text)
 */
function ReplyIndicator({ room, re }: { room: RoomApi; re: string }) {
  if (!room.sentIds.has(re)) {
    const quoted = room.messages.find((candidate) => candidate.id === re);
    if (quoted !== undefined) {
      return (
        <div className="reply-quote" data-testid="reply-quote">
          <span className="reply-quote-text">{quoted.text}</span>
        </div>
      );
    }
  }
  return (
    <div className="reply-generic" data-testid="reply-generic">
      <span className="reply-generic-text">replying to something you said</span>
    </div>
  );
}
