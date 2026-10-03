import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Home } from "./Home";
import { parseRoute } from "./router";

const INVITE_RE = /^https?:\/\/[^/]+\/r\/[A-Za-z0-9_-]{11}#[A-Za-z0-9_-]{22}$/;

afterEach(() => {
  cleanup();
  window.history.pushState(null, "", "/");
});

describe("Home", () => {
  it("starts with a single Create chat action and the honest notice", () => {
    render(<Home />);
    expect(screen.getByRole("button", { name: "Create chat" })).toBeTruthy();
    expect(screen.getByText("What this protects")).toBeTruthy();
    expect(screen.getByText("What this does not protect")).toBeTruthy();
    expect(screen.queryByTestId("invite-link")).toBeNull();
  });

  it("creates a link with an 11-char room id and the secret only in the fragment", () => {
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));

    const link = screen.getByTestId("invite-link").textContent ?? "";
    expect(link).toMatch(INVITE_RE);

    const url = new URL(link);
    expect(url.pathname).toMatch(/^\/r\/[A-Za-z0-9_-]{11}$/);
    expect(url.hash).toMatch(/^#[A-Za-z0-9_-]{22}$/);
    // The current page URL must not contain the secret at all yet.
    expect(window.location.href).not.toContain(url.hash.slice(1));
  });

  it("navigates into the room with the secret in the fragment only", () => {
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));
    const link = screen.getByTestId("invite-link").textContent ?? "";
    const url = new URL(link);
    const secret = url.hash.slice(1);

    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));

    expect(window.location.pathname).toBe(url.pathname);
    expect(window.location.hash).toBe(url.hash);
    // Secret never appears outside the fragment.
    expect(window.location.pathname).not.toContain(secret);
    expect(window.location.search).not.toContain(secret);
    expect(window.location.href.indexOf(secret)).toBeGreaterThan(window.location.href.indexOf("#"));
    expect(parseRoute(window.location.pathname)).toEqual({
      kind: "room",
      roomId: url.pathname.slice("/r/".length),
    });
  });

  it("copies the full link to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));
    const link = screen.getByTestId("invite-link").textContent ?? "";

    const copyButton = screen.getByRole("button", { name: "Copy link" });
    fireEvent.click(copyButton);
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(link);
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    });
  });

  it("shows Share only when navigator.share exists", () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "share", {
      value: share,
      configurable: true,
    });

    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));
    const shareButton = screen.getByRole("button", { name: "Share" });
    expect(shareButton).toBeTruthy();

    fireEvent.click(shareButton);
    const link = screen.getByTestId("invite-link").textContent ?? "";
    expect(share).toHaveBeenCalledWith({ url: link });

    // Remove it again for other tests.
    Object.defineProperty(window.navigator, "share", { value: undefined, configurable: true });
  });
});
