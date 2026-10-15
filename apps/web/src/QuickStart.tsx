import { useEffect, useState, type FormEvent } from "react";
import { MAX_PEERS, generateRoomId, generateSecret } from "@aside/protocol";
import { replaceRoute, setPendingInvite } from "./router";

/** One-tap sizes offered by the picker, limited to what MAX_PEERS allows. */
const QUICK_SIZES = [2, 3, 4, 5, 6, 8].filter((size) => size <= MAX_PEERS);

const SIZE_ERROR = `Choose a number from 2 to ${MAX_PEERS}.`;

function isUsableSize(count: number): boolean {
  return Number.isInteger(count) && count >= 2 && count <= MAX_PEERS;
}

/** Generates the room id and secret in the browser. Called only once a size is chosen. */
function buildInviteLink(size: number): string {
  const roomId = generateRoomId();
  const secret = generateSecret();
  // Same shape as Home: the group size rides in the query, the secret in the fragment.
  const settings = new URLSearchParams({ cap: String(size) });
  return `${window.location.origin}/r/${roomId}?${settings.toString()}#${secret}`;
}

/**
 * Makes the invite and moves to the home screen, which shows it. /new is replaced
 * in the address bar, so the router and the address bar always agree.
 */
function openInvite(size: number): void {
  setPendingInvite(buildInviteLink(size));
  replaceRoute("/");
}

/**
 * Quick start at /new or /new/:count. A valid count creates the chat at once;
 * anything else shows the size picker. No room id or secret exists before a
 * size is chosen.
 */
export function QuickStart({ requested }: { requested: number | null }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(() =>
    requested !== null && !isUsableSize(requested) ? SIZE_ERROR : "",
  );

  const createAtOnce = requested !== null && isUsableSize(requested);

  useEffect(() => {
    if (createAtOnce) {
      openInvite(requested);
    }
  }, [createAtOnce, requested]);

  // A valid count leaves this screen straight away; render nothing in the meantime.
  if (createAtOnce) {
    return null;
  }

  function create(size: number): void {
    setError("");
    openInvite(size);
  }

  function submitDraft(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = draft.trim();
    const size = Number(trimmed);
    if (trimmed === "" || !isUsableSize(size)) {
      setError(SIZE_ERROR);
      return;
    }
    create(size);
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

        <section className="hero" aria-labelledby="quick-title">
          <div className="hero-copy">
            <h1 className="title" id="quick-title">
              Start a <em>private</em> chat.
            </h1>

            <div className="create-panel">
              <form className="size-form" onSubmit={submitDraft} noValidate>
                <fieldset className="size-picker">
                  <legend className="size-legend">How many people will be in this chat?</legend>
                  <div className="size-options">
                    {QUICK_SIZES.map((size) => (
                      <button
                        key={size}
                        type="button"
                        className="size-option"
                        onClick={() => create(size)}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label className="size-entry">
                  <span>Or type a number from 2 to {MAX_PEERS}</span>
                  <input
                    className="input size-input"
                    type="number"
                    inputMode="numeric"
                    min={2}
                    max={MAX_PEERS}
                    step={1}
                    value={draft}
                    aria-invalid={error !== "" ? true : undefined}
                    aria-describedby={error !== "" ? "size-error" : undefined}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      setError("");
                    }}
                  />
                </label>
                <button type="submit" className="btn btn-primary">
                  Create chat
                </button>
              </form>
              <p className="size-error" id="size-error" role="alert">
                {error}
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
