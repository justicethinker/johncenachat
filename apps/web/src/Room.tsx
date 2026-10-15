import { Chat } from "./Chat";
import { navigate } from "./router";
import { type EndReason, useRoom } from "./useRoom";

const END_MESSAGES: Record<EndReason, string> = {
  left: "You ended this chat.",
  peer_left: "The other person left. This chat is closed.",
  creator_left: "The person who created this chat left. This chat is closed.",
  idle: "This chat closed because nobody was talking.",
  expired: "This chat reached its time limit and was closed.",
  waiting_timeout: "Nobody joined in time, so this chat was closed.",
  reconnect_failed: "The connection was lost and could not be restored. This chat is closed.",
  room_full: "This room is full or closed.",
  bad_auth: "This link does not match this chat.",
  bad_room: "This link is not valid.",
  bad_format: "Something went wrong. Reopen the link from the start.",
  rate_limited: "Too many attempts. Try again in a minute.",
  too_large: "That message was too large to send.",
  room_locked: "This room is full or closed.",
  bad_cap: "That room link is not valid.",
  closed_by_creator: "The host closed this chat.",
  not_creator: "Only the host can do that.",
};

const ERROR_MESSAGES: Record<string, string> = {
  rate_limited: "Slow down — you are sending too fast.",
  too_large: "That message is too large.",
  bad_format: "The server rejected a message.",
  room_full: "This chat is full.",
  room_locked: "The host locked this chat.",
  not_creator: "Only the host can do that.",
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
          <h1 className="title">
            <a
              className="title-link"
              href="/"
              aria-label="Aside home"
              onClick={(event) => {
                event.preventDefault();
                navigate("/");
              }}
            >
              Aside
            </a>
          </h1>
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
          <h1 className="title">
            <a
              className="title-link"
              href="/"
              aria-label="Aside home"
              onClick={(event) => {
                event.preventDefault();
                navigate("/");
              }}
            >
              Aside
            </a>
          </h1>
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

  // Our own label counts as present once we have joined.
  const presentCount = 1 + room.members.filter((member) => member.present).length;
  const showVanishNotice = room.vanish && room.cap > 2;

  return (
    <main className="page page-chat">
      <div className="chat">
        <header className="chat-header">
          <span className="you-are" data-testid="label">
            {room.label ? `You are ${room.label}` : "Connecting…"}
          </span>
          {room.isCreator && (
            <span className="host-tag" data-testid="host-tag">
              Host
            </span>
          )}
          <span className="header-side">
            {room.isCreator && (
              <button
                type="button"
                className="btn btn-quiet lock-room"
                data-testid="lock-room"
                onClick={room.lock}
                disabled={room.locked}
              >
                {room.locked ? "Locked" : "Lock room"}
              </button>
            )}
            <span
              className={room.peerPresent ? "presence presence-on" : "presence presence-off"}
              data-testid="presence"
              aria-label={room.peerPresent ? "Someone else is here" : "No one else is connected"}
            />
            <button
              type="button"
              className="btn btn-quiet end-chat"
              data-testid="end-chat"
              onClick={room.endChat}
            >
              End chat
            </button>
          </span>
        </header>
        {showVanishNotice && (
          <p className="vanish-notice" data-testid="vanish-notice">
            Messages vanish when their sender leaves.
          </p>
        )}

        {room.label && (
          <div className="members" data-testid="members">
            <p className="members-count">
              {presentCount} of {room.cap} here{room.locked ? " · locked" : ""}
            </p>
            {room.members.length > 0 && (
              <ul className="member-list" aria-label="Others in this chat">
                {room.members.map((member) => (
                  <li
                    key={member.label}
                    className={member.present ? "member member-on" : "member member-off"}
                    data-testid="member"
                  >
                    {member.label}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="chat-body">
          {room.status === "connecting" && (
            <p className="status-line" data-testid="connecting">
              Connecting…
            </p>
          )}
          {room.status === "waiting" && (
            <p className="status-line" data-testid="waiting">
              Waiting for people to open the link…
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
