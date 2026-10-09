import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Home } from "./Home";
import { parseRoute } from "./router";

const INVITE_RE = /^https?:\/\/[^/]+\/r\/[A-Za-z0-9_-]{11}\?cap=[2-8]#[A-Za-z0-9_-]{22}$/;

afterEach(() => {
  cleanup();
  window.history.pushState(null, "", "/");
});

describe("Home", () => {
  it("starts with a single Create chat action and the honest notice", () => {
    render(<Home />);
    expect(screen.getByRole("button", { name: "Create chat" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "A conversation without a transcript." }),
    ).toBeTruthy();
    expect(screen.getByText("What it protects")).toBeTruthy();
    expect(screen.getByText("What it can’t protect")).toBeTruthy();
    expect(screen.getByText("One-sided by design")).toBeTruthy();
    expect(
      screen.getByText("A quieter place to talk. Not a way to control what someone else keeps."),
    ).toBeTruthy();
    expect(screen.queryByTestId("invite-link")).toBeNull();
  });

  it("creates a link with an 11-char room id and the secret only in the fragment", () => {
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));

    const link = screen.getByTestId("invite-link").textContent ?? "";
    expect(link).toMatch(INVITE_RE);

    const url = new URL(link);
    expect(url.pathname).toMatch(/^\/r\/[A-Za-z0-9_-]{11}$/);
    // The group size rides in the query; the secret stays in the fragment.
    expect(url.searchParams.get("cap")).toBe("8");
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
    expect(window.location.search).toBe(url.search);
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

  it("lets the creator pick a group size, which goes into the link", () => {
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    expect(screen.getByRole("button", { name: "3" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "8" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));
    const url = new URL(screen.getByTestId("invite-link").textContent ?? "");
    expect(url.searchParams.get("cap")).toBe("3");
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

  it("selects the invite and explains the manual copy fallback when clipboard access is unavailable", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });

    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));
    const link = screen.getByTestId("invite-link").textContent ?? "";
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe(
      "The link is selected. Copy it, then share it privately with the people you want here.",
    );
    expect(window.getSelection()?.toString()).toBe(link);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
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
