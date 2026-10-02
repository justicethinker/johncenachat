import { Chat } from "./Chat";
import { navigate } from "./router";
import { type EndReason, useRoom } from "./useRoom";

const END_MESSAGES: Record<EndReason, string> = {
  peer_left: "The other person left. This chat is closed.",
  idle: "This chat closed because nobody was talking.",
  expired: "This chat reached its time limit and was closed.",
  waiting_timeout: "Nobody joined in time, so this chat was closed.",
  reconnect_failed: "The connection was lost and could not be restored. This chat is closed.",
  room_full: "This chat already has two people in it.",
  bad_auth: "This link does not match this chat.",
  bad_room: "This link is not valid.",
  bad_format: "Something went wrong. Reopen the link from the start.",
  rate_limited: "Too many attempts. Try again in a minute.",
  too_large: "That message was too large to send.",
};

const ERROR_MESSAGES: Record<string, string> = {
  rate_limited: "Slow down — you are sending too fast.",
  too_large: "That message is too large.",
  bad_format: "The server rejected a message.",
  room_full: "This chat is full.",
  bad_auth: "This link does not match this chat.",
  bad_room: "This link is not valid.",
  blocked: "Blocked.",
};

function endMessage(reason: EndReason | null): string {
  if (reason && reason in END_MESSAGES) return END_MESSAGES[reason];
  return "This chat is closed.";
}

/**
 * Room screen: header with own label and presence dot, status screens for
 * connecting / waiting / ended, and (step 6) the one-sided message list.
 */
export function Room({ roomId }: { roomId: string }) {
  const room = useRoom(roomId);

  if (room.status === "incomplete") {
    return (
      <main className="page">
        <div className="home">
          <h1 className="title">Aside</h1>
          <p className="tagline" data-testid="incomplete">
            This link is incomplete
          </p>
          <p className="hint">Ask for the full link again — everything after # matters.</p>
        </div>
      </main>
    );
  }

  if (room.status === "ended") {
    return (
      <main className="page">
        <div className="home">
          <h1 className="title">Aside</h1>
          <p className="tagline" data-testid="ended">
            {endMessage(room.endReason)}
          </p>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => navigate("/")}>
              Start a new chat
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="chat">
        <header className="chat-header">
          <span className="you-are" data-testid="label">
            {room.label ? `You are ${room.label}` : "Connecting…"}
          </span>
          <span
            className={room.peerPresent ? "presence presence-on" : "presence presence-off"}
            data-testid="presence"
            aria-label={
              room.peerPresent ? "The other person is here" : "The other person is not connected"
            }
          />
        </header>

        <div className="chat-body">
          {room.status === "connecting" && (
            <p className="status-line" data-testid="connecting">
              Connecting…
            </p>
          )}
          {room.status === "waiting" && (
            <p className="status-line" data-testid="waiting">
              Waiting for the other person to open the link…
            </p>
          )}
          <Chat room={room} />
          {room.lastError && (
            <p className="banner" role="alert" data-testid="error-banner">
              {ERROR_MESSAGES[room.lastError] ?? "Something went wrong."}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
