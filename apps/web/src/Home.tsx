import { useState } from "react";
import { MAX_PEERS, generateRoomId, generateSecret } from "@aside/protocol";
import { InviteLink } from "./InviteLink";
import { takePendingInvite } from "./router";

/** Group sizes the creator can pick. The server default is MAX_PEERS. */
const SIZE_OPTIONS = Array.from({ length: MAX_PEERS - 1 }, (_, index) => index + 2);

export function Home() {
  // A quick-start invite arrives here already made, and is shown once.
  const [link, setLink] = useState<string | null>(() => takePendingInvite());
  const [size, setSize] = useState<number>(MAX_PEERS);
  const [vanish, setVanish] = useState(true);

  function createChat(): void {
    const roomId = generateRoomId();
    const secret = generateSecret();
    // Creation settings ride in the query; the fragment stays the secret alone.
    const settings = new URLSearchParams({ cap: String(size) });
    if (!vanish) settings.set("vanish", "0");
    setLink(`${window.location.origin}/r/${roomId}?${settings.toString()}#${secret}`);
  }

  return (
    <main className="page page-home">
      <div className="home">
        <header className="brand-line">
          <a className="wordmark" href="/" aria-label="Aside home">
            Aside<span aria-hidden="true">.</span>
          </a>
          <span className="brand-note">Private chat for small groups</span>
        </header>

        <section className="hero" aria-labelledby="home-title">
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="signal-dot" aria-hidden="true" />
              No account. No saved history.
            </p>
            <h1 className="title" id="home-title">
              A conversation
              <br />
              without a <em>transcript.</em>
            </h1>
            <p className="tagline">
              Messages are encrypted in your browser. The relay passes them along, but never saves a
              chat history.
            </p>

            {link === null ? (
              <div className="create-panel">
                <fieldset className="size-picker">
                  <legend className="size-legend">How many people can join?</legend>
                  <div className="size-options">
                    {SIZE_OPTIONS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={option === size ? "size-option size-option-on" : "size-option"}
                        aria-pressed={option === size}
                        onClick={() => setSize(option)}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </fieldset>
                {size > 2 && (
                  <label className="vanish-choice">
                    <input
                      type="checkbox"
                      checked={vanish}
                      onChange={(event) => setVanish(event.target.checked)}
                    />
                    <span>Messages vanish when their sender leaves</span>
                  </label>
                )}
                <button type="button" className="btn btn-primary" onClick={createChat}>
                  Create chat
                </button>
                <p className="action-note">
                  Make a private link. You are the host and can lock the room once everyone is in.
                </p>
              </div>
            ) : (
              <InviteLink link={link} />
            )}
          </div>

          <aside
            className="exchange"
            aria-label="Only the other person’s messages appear on your screen"
          >
            <div className="exchange-heading">
              <span>One-sided by design</span>
              <span className="exchange-mark" aria-hidden="true">
                ↗
              </span>
            </div>
            <div className="exchange-panes">
              <div className="exchange-pane">
                <span className="pane-label">On your screen</span>
                <p className="pane-message">Only what they send.</p>
                <span className="pane-note">Your own messages aren’t shown.</span>
              </div>
              <div className="exchange-connector" aria-hidden="true">
                <span />
              </div>
              <div className="exchange-pane exchange-pane-other">
                <span className="pane-label">On their screen</span>
                <p className="pane-message">Only what you send.</p>
                <span className="pane-note">No names attached.</span>
              </div>
            </div>
          </aside>
        </section>

        <section className="notice" aria-label="What to expect">
          <div className="notice-col">
            <h2 className="notice-title">What it protects</h2>
            <ul className="notice-list notice-yes">
              <li>Your messages are unreadable to the relay.</li>
              <li>No account and no saved chat history.</li>
              <li>The room closes when the host leaves.</li>
            </ul>
          </div>
          <div className="notice-col notice-limits">
            <h2 className="notice-title">What it can’t protect</h2>
            <ul className="notice-list notice-no">
              <li>The other person can still save or remember your words.</li>
              <li>The full invite link is the key. Share it only with the person you intend.</li>
              <li>The app you use to send the link may keep a record of that message.</li>
            </ul>
          </div>
        </section>

        <p className="home-footnote">
          A quieter place to talk. Not a way to control what someone else keeps.
        </p>
      </div>
    </main>
  );
}
