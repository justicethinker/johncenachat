import { useRef, useState } from "react";
import { navigate } from "./router";

/**
 * The invite card shown once a chat link exists: the full link, Copy, Share
 * (when the browser supports it) and Open chat. Shared by Home and quick start.
 */
export function InviteLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  const [copyHelp, setCopyHelp] = useState("");
  const linkRef = useRef<HTMLDivElement | null>(null);

  const shareSupported = typeof navigator.share === "function";

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setCopyHelp("Invite link copied. Share it privately with the people you want here.");
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
      setCopyHelp(
        "The link is selected. Copy it, then share it privately with the people you want here.",
      );
    }
  }

  function share(): void {
    if (typeof navigator.share !== "function") return;
    void navigator.share({ url: link }).catch(() => {
      // Cancellation is intentional; the invite remains available to copy.
    });
  }

  function openChat(): void {
    const url = new URL(link);
    navigate(`${url.pathname}${url.search}${url.hash}`);
  }

  return (
    <div className="link-card">
      <p className="invite-title">Your invite link</p>
      <p className="hint">
        Share the full link privately. The part after # is the key. Whoever opens it first becomes
        the host.
      </p>
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
  );
}
