import { expect, test, type Page } from "@playwright/test";

/**
 * Group chat against the production build (`pnpm test:e2e`): one host and
 * several guests in isolated contexts, all talking through `vite preview`,
 * which proxies /ws to the relay exactly like Caddy does in production.
 */

/** Create a group chat of the given size and return the invite link. */
async function createGroupChat(page: Page, size: number): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: String(size), exact: true }).click();
  await page.getByRole("button", { name: "Create chat" }).click();
  const link = (await page.getByTestId("invite-link").innerText()).trim();
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page.getByTestId("waiting")).toBeVisible();
  return link;
}

/** The composer only renders once the room is active (someone else is here). */
async function waitActive(page: Page): Promise<void> {
  await expect(page.getByTestId("message-input")).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("message-input");
  await input.fill(text);
  await input.press("Enter");
}

/** The 4-digit label shown in the header, e.g. "You are 4821" -> "4821". */
async function myLabel(page: Page): Promise<string> {
  const text = (await page.getByTestId("label").innerText()).trim();
  return text.replace("You are ", "");
}

test("vanish-on-leave removes only the departed sender's messages after grace", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const contextHost = await browser.newContext();
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const host = await contextHost.newPage();

  try {
    // Simulate an abrupt drop of A: swallow the graceful `leave` the app sends
    // on pagehide, so the relay sees only a socket close and applies the
    // reconnect grace before broadcasting `left`.
    await contextA.addInitScript(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (data === '{"type":"leave"}') return;
        return send.call(this, data);
      };
    });
    const link = await createGroupChat(host, 8);
    const a = await contextA.newPage();
    await a.goto(link);
    await waitActive(a);
    const labelA = await myLabel(a);
    const b = await contextB.newPage();
    await b.goto(link);
    await waitActive(b);
    await waitActive(host);

    await expect(host.getByTestId("vanish-notice")).toHaveText(
      "Messages vanish when their sender leaves.",
    );

    await send(a, "vanish-from-a");
    await send(b, "keep-from-b");
    await expect(host.getByText("vanish-from-a")).toBeVisible();
    await expect(host.getByText("keep-from-b")).toBeVisible();

    // Close A's tab without a graceful leave. The relay should mark A away
    // (message remains) and remove it only after the reconnect grace expires
    // and the relay broadcasts `left`.
    await a.close();
    const memberA = host.locator('[data-testid="member"]').filter({ hasText: labelA });
    await expect(memberA).toHaveClass(/member-off/);
    await expect(host.getByText("vanish-from-a")).toBeVisible();
    await expect(host.getByText("vanish-from-a")).toHaveCount(0, { timeout: 45_000 });
    await expect(host.getByText("keep-from-b")).toBeVisible();
    await expect(host.getByTestId("members")).toContainText("2 of 8 here");
  } finally {
    await contextHost.close();
    await contextA.close();
    await contextB.close();
  }
});

test("a group: labels group messages, only the host can lock, and the host leaving closes it", async ({
  browser,
}) => {
  const contextHost = await browser.newContext();
  const contextB = await browser.newContext();
  const contextC = await browser.newContext();
  const contextLate = await browser.newContext();
  const host = await contextHost.newPage();

  try {
    const link = await createGroupChat(host, 8);
    expect(new URL(link).searchParams.get("cap")).toBe("8");

    const b = await contextB.newPage();
    await b.goto(link);
    await waitActive(b);
    const c = await contextC.newPage();
    await c.goto(link);
    await waitActive(c);
    await waitActive(host);

    const labelB = await myLabel(b);
    const labelC = await myLabel(c);
    expect(labelB).toMatch(/^\d{4}$/);
    expect(labelC).toMatch(/^\d{4}$/);

    // The host sees the host tag and the lock control; guests do not.
    await expect(host.getByTestId("host-tag")).toHaveText("Host");
    await expect(host.getByTestId("lock-room")).toHaveText("Lock room");
    await expect(b.getByTestId("lock-room")).toHaveCount(0);
    await expect(b.getByTestId("host-tag")).toHaveCount(0);
    // Three people here out of the room's eight.
    await expect(host.getByTestId("members")).toContainText("3 of 8 here");

    // Two messages from B in a row share one label; C's message gets its own.
    await send(b, "one-from-b");
    await send(b, "two-from-b");
    await expect(host.locator("body")).toContainText("two-from-b");
    await send(c, "from-c");
    await expect(host.locator("body")).toContainText("from-c");
    await expect(host.getByTestId("message-label")).toHaveText([labelB, labelC]);

    // The host's own messages are never shown on the host's screen.
    await send(host, "from-host");
    await expect(b.locator("body")).toContainText("from-host");
    await expect(host.locator("body")).not.toContainText("from-host");

    // A guest leaving removes only that guest.
    await c.getByTestId("end-chat").click();
    await expect(c.getByTestId("ended")).toHaveText("You ended this chat.");
    await expect(host.getByTestId("members")).toContainText("2 of 8 here");
    await waitActive(b);

    // The host locks the room; guests see it and a late joiner is turned away.
    await host.getByTestId("lock-room").click();
    await expect(host.getByTestId("lock-room")).toHaveText("Locked");
    await expect(b.getByTestId("members")).toContainText("locked");

    const late = await contextLate.newPage();
    await late.goto(link);
    await expect(late.getByTestId("ended")).toHaveText("This room is full or closed.");

    // The host leaving closes the chat for everyone still in it.
    await host.getByTestId("end-chat").click();
    await expect(b.getByTestId("ended")).toHaveText(
      "The person who created this chat left. This chat is closed.",
      { timeout: 45_000 },
    );
  } finally {
    await contextHost.close();
    await contextB.close();
    await contextC.close();
    await contextLate.close();
  }
});
