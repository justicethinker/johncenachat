import { expect, test, type Page, type WebSocket } from "@playwright/test";

/**
 * Quick start (/new and /new/:count) against the production build. A valid
 * count creates the chat at once; anything else shows the size picker and
 * opens no socket. The room secret is never sent over the network.
 */

function inviteLink(page: Page) {
  return page.getByTestId("invite-link");
}

async function link(page: Page): Promise<URL> {
  return new URL((await inviteLink(page).innerText()).trim());
}

test("/new/4 creates a chat of four at once and drops /new from the address bar", async ({
  page,
}) => {
  await page.goto("/new/4");

  const url = await link(page);
  expect(url.pathname).toMatch(/^\/r\/[A-Za-z0-9_-]{11}$/);
  expect(url.searchParams.get("cap")).toBe("4");
  expect(url.hash).toMatch(/^#[A-Za-z0-9_-]{22}$/);

  // The address bar no longer shows /new, and carries no fragment at all.
  const current = new URL(page.url());
  expect(current.pathname).toBe("/");
  expect(current.hash).toBe("");
});

test("/new, /new/1, /new/99 and /new/abc show the picker and open no socket", async ({ page }) => {
  const sockets: WebSocket[] = [];
  page.on("websocket", (socket) => sockets.push(socket));

  for (const path of ["/new", "/new/1", "/new/99", "/new/abc"]) {
    await page.goto(path);
    await expect(page.getByText("How many people will be in this chat?")).toBeVisible();
    await expect(inviteLink(page)).toHaveCount(0);
    // No room id or secret is generated, and /new stays until a size is chosen.
    expect(new URL(page.url()).pathname).toBe(path);
  }

  await page.goto("/new/99");
  await expect(page.getByRole("alert")).toHaveText("Choose a number from 2 to 8.");

  expect(sockets).toHaveLength(0);
});

test("the picker creates a chat with the chosen size, by button or typed number", async ({
  page,
}) => {
  await page.goto("/new");
  await page.getByRole("button", { name: "4" }).click();
  expect((await link(page)).searchParams.get("cap")).toBe("4");
  expect(new URL(page.url()).pathname).toBe("/");

  const typed = await page.context().newPage();
  await typed.goto("/new");
  await typed.getByRole("spinbutton").fill("5");
  await typed.getByRole("button", { name: "Create chat" }).click();
  expect((await link(typed)).searchParams.get("cap")).toBe("5");
  await typed.close();
});

test("the picker rejects an out-of-range typed number inline and creates nothing", async ({
  page,
}) => {
  await page.goto("/new");
  await page.getByRole("spinbutton").fill("9");
  await page.getByRole("button", { name: "Create chat" }).click();

  await expect(page.getByRole("alert")).toHaveText("Choose a number from 2 to 8.");
  await expect(inviteLink(page)).toHaveCount(0);
});

test("the room secret never appears in a request or a WebSocket frame", async ({ page }) => {
  const requestUrls: string[] = [];
  const sentFrames: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) => {
      if (typeof event.payload === "string") sentFrames.push(event.payload);
    });
  });

  await page.goto("/new/3");
  const url = await link(page);
  const secret = url.hash.slice(1);
  expect(secret).toHaveLength(22);

  // Opening the chat uses the fragment only in the browser; the join frame follows.
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page.getByTestId("waiting")).toBeVisible();
  await expect.poll(() => sentFrames.length).toBeGreaterThan(0);

  for (const requestUrl of requestUrls) {
    expect(requestUrl).not.toContain(secret);
  }
  for (const frame of sentFrames) {
    expect(frame).not.toContain(secret);
  }
  // The room reads the secret from the fragment, then strips it from the address bar.
  expect(new URL(page.url()).hash).toBe("");
  expect(page.url()).not.toContain(secret);
});
