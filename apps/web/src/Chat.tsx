import { MAX_TEXT_LENGTH } from "@aside/protocol";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { type ReceivedMessage, type RoomApi } from "./useRoom";

const TICK_VISIBLE_MS = 1200;
const LONG_PRESS_MS = 500;

/**
 * Set to a positive number of milliseconds to make received messages fade
 * after that long. Default off (spec section 8).
 */
export const MESSAGE_VISIBLE_MS = 0;

/**
 * One-sided group chat UI: the list shows only received messages, grouped
 * by sender label, without timestamps or own bubbles. The input clears
 * immediately on send; after an ack a small
 * "delivered" tick appears and fades after ~1.2s.
 *
 * Privacy: when the tab loses focus or is hidden the list is blurred
 * behind a "Tap to reveal" overlay (a deterrent, not a guarantee).
 *
 * Reply (spec step 7): click or long-press a received message to reveal
 * Reply; the composer shows a quote chip with a cancel button. Outgoing
 * payloads carry `re`. Incoming replies to something *this screen* sent
 * render as a generic chip with no quoted text.
 */
interface MessageGroup {
  from: string;
  messages: ReceivedMessage[];
}

/** Consecutive messages from the same sender label share one header. */
function groupByLabel(messages: ReceivedMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const message of messages) {
    const last = groups.at(-1);
    if (last && last.from === message.from) {
      last.messages.push(message);
    } else {
      groups.push({ from: message.from, messages: [message] });
    }
  }
  return groups;
}

export function Chat({ room }: { room: RoomApi }) {
  const [draft, setDraft] = useState("");
  const [tickVisible, setTickVisible] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const replyTo =
    replyToId === null ? null : room.messages.find((message) => message.id === replyToId);
  const [obscured, setObscured] = useState(false);
  const [revealed, setRevealed] = useState(false);
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

  // Blur the list behind "Tap to reveal" while the tab is hidden or unfocused.
  useEffect(() => {
    const onVisibility = (): void => {
      setObscured(document.hidden || !document.hasFocus());
    };
    const onBlur = (): void => setObscured(true);
    const onFocus = (): void => setObscured(false);
    // Initial state: only trust document.hidden (focus is event-driven).
    setObscured(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    if (obscured) {
      // Any transition to hidden re-arms the overlay.
      setRevealed(false);
    }
  }, [obscured]);

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
    setReplyToId(message.id);
    setSelectedId(null);
  }

  function send(): void {
    const text = draft;
    if (text.length === 0) return;
    const re = replyToId ?? undefined;
    const accepted = re !== undefined ? room.sendMessage(text, re) : room.sendMessage(text);
    if (accepted) {
      setDraft(""); // clears immediately on send
      setReplyToId(null);
    }
  }

  const hideContent = obscured && !revealed;

  return (
    <>
      <div className="messages-frame">
        <div
          className={hideContent ? "messages message-blurred" : "messages"}
          ref={listRef}
          data-testid="messages"
        >
          {groupByLabel(room.messages).map((group) => (
            <section className="message-group" key={group.messages[0]!.id}>
              <span className="message-label" data-testid="message-label">
                {group.from}
              </span>
              {group.messages.map((message) => (
                <MessageItem
                  key={message.id}
                  room={room}
                  message={message}
                  selected={selectedId === message.id}
                  onSelect={onMessageClick}
                  onLongPressStart={beginLongPress}
                  onLongPressCancel={cancelLongPress}
                  onReply={chooseReply}
                />
              ))}
            </section>
          ))}
        </div>
        {hideContent && (
          <button
            type="button"
            className="reveal-overlay"
            data-testid="tap-to-reveal"
            onClick={() => setRevealed(true)}
          >
            Tap to reveal
          </button>
        )}
      </div>

      {room.status === "active" && (
        <div className="composer-wrap">
          {replyToId !== null && (
            <div className="reply-chip" data-testid="reply-chip">
              <span className="reply-chip-text">
                {replyTo?.text ?? "replying to an earlier message"}
              </span>
              <button
                type="button"
                className="reply-cancel"
                aria-label="Cancel reply"
                onClick={() => setReplyToId(null)}
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
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
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

interface MessageItemProps {
  room: RoomApi;
  message: ReceivedMessage;
  selected: boolean;
  onSelect: (id: string) => void;
  onLongPressStart: (id: string) => void;
  onLongPressCancel: () => void;
  onReply: (message: ReceivedMessage, event: MouseEvent) => void;
}

function MessageItem({
  room,
  message,
  selected,
  onSelect,
  onLongPressStart,
  onLongPressCancel,
  onReply,
}: MessageItemProps) {
  const [faded, setFaded] = useState(false);

  useEffect(() => {
    if (MESSAGE_VISIBLE_MS <= 0) return;
    const timer = setTimeout(() => setFaded(true), MESSAGE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [message.id]);

  const className = MESSAGE_VISIBLE_MS > 0 && faded ? "message message-faded" : "message";

  return (
    <div
      className={className}
      onClick={() => onSelect(message.id)}
      onPointerDown={() => onLongPressStart(message.id)}
      onPointerUp={onLongPressCancel}
      onPointerLeave={onLongPressCancel}
      onPointerCancel={onLongPressCancel}
      onContextMenu={(event) => event.preventDefault()}
    >
      {selected && (
        <button
          type="button"
          className="reply-option"
          data-testid="reply-option"
          onClick={(event) => onReply(message, event)}
        >
          Reply
        </button>
      )}
      {message.re !== undefined && <ReplyIndicator room={room} re={message.re} />}
      <span className="message-text">{message.text}</span>
    </div>
  );
}

/**
 * A received message that replies to something:
 *  - a message this screen sent -> generic chip, never quoted text
 *  - a message this screen received -> the quoted text
 *  - vanished or unknown id -> generic chip, without retaining quoted text
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
      <span className="reply-generic-text">
        {room.sentIds.has(re) ? "replying to something you said" : "replying to an earlier message"}
      </span>
    </div>
  );
}
