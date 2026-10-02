import { useRef, useState } from "react";
import { generateRoomId, generateSecret } from "@aside/protocol";
import { navigate } from "./router";

/**
 * Home: one button, **Create chat**. Generates roomId + secret locally,
 * builds /r/{roomId}#{secret}, shows Copy and Share. The secret only ever
 * exists in the URL fragment and in memory.
 */
export function Home() {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLDivElement | null>(null);

  const shareSupported = typeof navigator.share === "function";

  function createChat(): void {
    const roomId = generateRoomId();
    const secret = generateSecret();
    setLink(`${window.location.origin}/r/${roomId}#${secret}`);
    setCopied(false);
  }

  async function copy(): Promise<void> {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard unavailable: select the visible link so it can be copied by hand.
      const element = linkRef.current;
      if (element) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  }

  function share(): void {
    if (!link || typeof navigator.share !== "function") return;
    void navigator.share({ url: link }).catch(() => {
      // User cancelled or sharing failed; nothing to do.
    });
  }

  function openChat(): void {
    if (!link) return;
    const url = new URL(link);
    navigate(`${url.pathname}${url.hash}`);
  }

  return (
    <main className="page">
      <div className="home">
        <h1 className="title">Aside</h1>
        <p className="tagline">A private chat for two. Nothing is stored.</p>

        {link === null ? (
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={createChat}>
              Create chat
            </button>
          </div>
        ) : (
          <div className="link-card">
            <p className="hint">Send this link to the one other person:</p>
            <div className="link-box" ref={linkRef} data-testid="invite-link">
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
          </div>
        )}

        <section className="notice">
          <h2>What this protects</h2>
          <ul>
            <li>
              Messages are encrypted in your browser. The server only relays ciphertext it cannot
              read.
            </li>
            <li>Nothing is stored. When either person leaves, the room is destroyed.</li>
            <li>
              Each screen shows only the other person&apos;s messages, so a screenshot proves
              nothing about who said what.
            </li>
          </ul>
          <h2>What this does not protect</h2>
          <ul>
            <li>
              The other person can still screenshot, copy, retype or remember what you send them.
            </li>
            <li>
              The link is the only secret. Anyone who gets it before your friend joins can take that
              seat.
            </li>
            <li>
              Sending the link over WhatsApp is itself a record that you invited them. Share it by
              voice or in a disappearing chat if that matters.
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}
