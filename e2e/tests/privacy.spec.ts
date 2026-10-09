import { expect, test, type Page } from "@playwright/test";

/**
 * Spec step 9. Runs against the production build (`pnpm test:e2e`):
 * two isolated browser contexts join the same room through `vite preview`,
 * which proxies /ws exactly like Caddy does in production.
 */

/** Everything one page put on the wire: HTTP requests and WS frames. */
interface Wire {
  requests: string[];
  frames: string[];
}

/**
 * Playwright hands frame listeners either the raw text or an envelope object
 * (`{ payload }`) depending on version. Always reduce it to readable text so
 * the leak assertions below actually inspect the bytes that went out.
 */
function frameText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload !== null && typeof payload === "object") {
    const envelope = payload as { payload?: unknown };
    if (typeof envelope.payload === "string") return envelope.payload;
    const buffer = payload as { type?: string; data?: number[] };
    if (buffer.type === "Buffer" && Array.isArray(buffer.data)) {
      return Buffer.from(buffer.data).toString("utf8");
    }
  }
  return JSON.stringify(payload) ?? String(payload);
}

function recordWire(page: Page, sink: Wire): void {
  page.on("request", (request) => {
    sink.requests.push(`${request.method()} ${request.url()}`);
  });
  page.on("websocket", (socket) => {
    socket.on("framesent", (payload) => sink.frames.push(frameText(payload)));
    socket.on("framereceived", (payload) => sink.frames.push(frameText(payload)));
  });
}

function haystack(sink: Wire): string {
  return [...sink.requests, ...sink.frames].join("\n");
}

/** Create a chat from the home screen and return the invite link. */
async function createChat(page: Page, size?: number): Promise<string> {
  await page.goto("/");
  if (size !== undefined) {
    await page.getByRole("button", { name: String(size), exact: true }).click();
  }
  await page.getByRole("button", { name: "Create chat" }).click();
  const link = (await page.getByTestId("invite-link").innerText()).trim();
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page.getByTestId("waiting")).toBeVisible();
  return link;
}

/**
 * Open the invite link in the given page. The page must already exist (and
 * have its wire recorder attached) before navigating, otherwise the test ends
 * up asserting against a blank tab.
 */
async function joinRoom(page: Page, link: string): Promise<void> {
  await page.goto(link);
}

/** The composer only renders once the room is active (both people present). */
async function waitActive(page: Page): Promise<void> {
  await expect(page.getByTestId("message-input")).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("message-input");
  await input.fill(text);
  await input.press("Enter");
}

test("two contexts exchange messages and each page shows only the other's text", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const a = await contextA.newPage();
  const wireA: Wire = { requests: [], frames: [] };
  recordWire(a, wireA);
  const wireB: Wire = { requests: [], frames: [] };

  try {
    const link = await createChat(a);
    const invite = new URL(link);
    const origin = invite.origin;
    const secret = invite.hash.slice(1);

    // The link is /r/{11-char roomId}#{secret}: the secret lives only in
    // the fragment, which is never part of any request.
    expect(invite.pathname).toMatch(/^\/r\/[A-Za-z0-9_-]{11}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // The fragment is stripped from the address bar right after load.
    expect(new URL(a.url()).hash).toBe("");

    const b = await contextB.newPage();
    recordWire(b, wireB);
    await joinRoom(b, link);
    await waitActive(a);
    await waitActive(b);

    // Random 4-digit labels, distinct within the room.
    const labelA = (await a.getByTestId("label").innerText()).trim();
    const labelB = (await b.getByTestId("label").innerText()).trim();
    expect(labelA).toMatch(/^You are \d{4}$/);
    expect(labelB).toMatch(/^You are \d{4}$/);
    expect(labelA).not.toBe(labelB);

    // Presence dot flips on for both sides.
    await expect(a.getByTestId("presence")).toHaveClass(/presence-on/);
    await expect(b.getByTestId("presence")).toHaveClass(/presence-on/);

    const textA = `only-from-a-${Date.now()}`;
    const textB = `only-from-b-${Date.now()}`;

    await send(a, textA);
    await expect(b.locator("body")).toContainText(textA);
    // One-sided: A never renders its own message, and the input clears.
    await expect(a.locator("body")).not.toContainText(textA);
    await expect(a.getByTestId("message-input")).toHaveValue("");
    // Ack came back: the delivered tick appears (and later fades).
    await expect(a.getByTestId("delivered-tick")).toHaveClass(/tick-visible/);

    await send(b, textB);
    await expect(a.locator("body")).toContainText(textB);
    await expect(b.locator("body")).not.toContainText(textB);

    // The secret never appears in any request or frame from either side...
    for (const [name, wire] of [
      ["A", wireA],
      ["B", wireB],
    ] as const) {
      expect(wire.frames.length, `no WebSocket frames captured for ${name}`).toBeGreaterThan(0);
      expect(wire.requests.length, `no requests captured for ${name}`).toBeGreaterThan(0);
      const all = haystack(wire);
      expect(all, `secret leaked on the wire for ${name}`).not.toContain(secret);
      // ...and neither does any plaintext message text.
      expect(all, `plaintext from A leaked for ${name}`).not.toContain(textA);
      expect(all, `plaintext from B leaked for ${name}`).not.toContain(textB);
      // Every request stays on this origin: no third-party hosts, ever.
      for (const request of wire.requests) {
        const url = request.slice(request.indexOf(" ") + 1);
        expect(
          url.startsWith(origin) || url.startsWith("data:"),
          `third-party request from ${name}: ${request}`,
        ).toBe(true);
      }
    }
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("a third context opening the same link gets room full", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const contextC = await browser.newContext();
  const a = await contextA.newPage();
  const b = await contextB.newPage();

  try {
    // A two-person room: the third person must be turned away by the size cap.
    const link = await createChat(a, 2);
    await joinRoom(b, link);
    await waitActive(a);
    await waitActive(b);

    const c = await contextC.newPage();
    await joinRoom(c, link);
    await expect(c.getByTestId("ended")).toHaveText("This room is full or closed.");

    // The existing pair is unaffected.
    await expect(a.getByTestId("presence")).toHaveClass(/presence-on/);
    await expect(b.getByTestId("presence")).toHaveClass(/presence-on/);
  } finally {
    await contextA.close();
    await contextB.close();
    await contextC.close();
  }
});

test("closing one context ends the other person's chat", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const a = await contextA.newPage();
  const b = await contextB.newPage();

  try {
    const link = await createChat(a);
    await joinRoom(b, link);
    await waitActive(a);
    await waitActive(b);

    await send(a, `hello-${Date.now()}`);
    await expect(b.getByTestId("messages")).not.toHaveCount(0);

    // A created the room, so A leaving closes it for everyone.
    await contextA.close();

    await expect(b.getByTestId("ended")).toHaveText(
      "The person who created this chat left. This chat is closed.",
      { timeout: 45_000 },
    );
  } finally {
    await contextB.close();
  }
});
