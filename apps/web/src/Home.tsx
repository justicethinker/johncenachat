import { useRef, useState } from "react";
import { generateRoomId, generateSecret } from "@aside/protocol";
import { navigate } from "./router";

export function Home() {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyHelp, setCopyHelp] = useState("");
  const linkRef = useRef<HTMLDivElement | null>(null);

  const shareSupported = typeof navigator.share === "function";

  function createChat(): void {
    const roomId = generateRoomId();
    const secret = generateSecret();
    setLink(`${window.location.origin}/r/${roomId}#${secret}`);
    setCopied(false);
    setCopyHelp("");
  }

  async function copy(): Promise<void> {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setCopyHelp("Invite link copied. Share it privately with one person.");
    } catch {
      const element = linkRef.current;
      if (element) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopied(false);
      setCopyHelp("The link is selected. Copy it, then share it privately with one person.");
    }
  }

  function share(): void {
    if (!link || typeof navigator.share !== "function") return;
    void navigator.share({ url: link }).catch(() => {
      // Cancellation is intentional; the invite remains available to copy.
    });
  }

  function openChat(): void {
    if (!link) return;
    const url = new URL(link);
    navigate(`${url.pathname}${url.hash}`);
  }

  return (
    <main className="page page-home">
      <div className="home">
        <header className="brand-line">
          <a className="wordmark" href="/" aria-label="Aside home">
            Aside<span aria-hidden="true">.</span>
          </a>
          <span className="brand-note">Private chat for two</span>
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
                <button type="button" className="btn btn-primary" onClick={createChat}>
                  Create chat
                </button>
                <p className="action-note">Make a private link to share with one person.</p>
              </div>
            ) : (
              <div className="link-card">
                <p className="invite-title">Your invite link</p>
                <p className="hint">Share the full link privately. The part after # is the key.</p>
                <div
                  className="link-box"
                  ref={linkRef}
                  data-testid="invite-link"
                  role="textbox"
                  aria-label="Private chat invite link"
                  aria-readonly="true"
                  tabIndex={0}
                >
                  {link}
                </div>
                <div className="actions">
                  <button type="button" className="btn btn-primary" onClick={() => void copy()}>
                    {copied ? "Copied" : "Copy link"}
                  </button>
                  {shareSupported && (
                    <button type="button" className="btn" onClick={share}>
                      Share
                    </button>
                  )}
                  <button type="button" className="btn" onClick={openChat}>
                    Open chat
                  </button>
                </div>
                <p className="copy-feedback" role="status" aria-live="polite">
                  {copyHelp}
                </p>
              </div>
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
              <li>The room closes when either person leaves.</li>
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
