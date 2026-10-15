import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  window.history.pushState(null, "", "/");
});

/** Renders the app at a path, the same way the browser would load it. */
function openAt(path: string): void {
  window.history.pushState(null, "", path);
  render(<App />);
}

function linkText(): string {
  return screen.getByTestId("invite-link").textContent ?? "";
}

describe("quick start", () => {
  it("creates the chat at once for a valid count and drops /new from the address bar", () => {
    openAt("/new/4");

    const url = new URL(linkText());
    expect(url.pathname).toMatch(/^\/r\/[A-Za-z0-9_-]{11}$/);
    expect(url.searchParams.get("cap")).toBe("4");
    expect(url.hash).toMatch(/^#[A-Za-z0-9_-]{22}$/);
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("");
    expect(screen.queryByText("How many people will be in this chat?")).toBeNull();
  });

  it("shows the picker and generates nothing when /new has no count", () => {
    openAt("/new");

    expect(screen.getByText("How many people will be in this chat?")).toBeTruthy();
    expect(screen.queryByTestId("invite-link")).toBeNull();
    expect(window.location.pathname).toBe("/new");
  });

  it("offers one-tap sizes from the shared MAX_PEERS limit", () => {
    openAt("/new");
    for (const size of ["2", "3", "4", "5", "6", "8"]) {
      expect(screen.getByRole("button", { name: size })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "7" })).toBeNull();
  });

  it.each([1, 99])("treats /new/%i as invalid and explains the range", (count) => {
    openAt(`/new/${count}`);

    expect(screen.getByRole("alert").textContent).toBe("Choose a number from 2 to 8.");
    expect(screen.queryByTestId("invite-link")).toBeNull();
    expect(window.location.pathname).toBe(`/new/${count}`);
  });

  it("treats /new/abc as no count and shows the picker without an error", () => {
    openAt("/new/abc");

    expect(screen.getByText("How many people will be in this chat?")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("");
    expect(screen.queryByTestId("invite-link")).toBeNull();
  });

  it("creates the chat with the chosen one-tap size", () => {
    openAt("/new");
    fireEvent.click(screen.getByRole("button", { name: "6" }));

    expect(new URL(linkText()).searchParams.get("cap")).toBe("6");
    expect(window.location.pathname).toBe("/");
  });

  it("creates the chat from a typed number", () => {
    openAt("/new");
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));

    expect(new URL(linkText()).searchParams.get("cap")).toBe("5");
  });

  it.each(["1", "9", "4.5", ""])("shows an inline error and no link for typed %j", (value) => {
    openAt("/new");
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));

    expect(screen.getByRole("alert").textContent).toBe("Choose a number from 2 to 8.");
    expect(screen.queryByTestId("invite-link")).toBeNull();
  });

  it("opens the room and then removes the secret from the address bar", () => {
    openAt("/new/3");
    const url = new URL(linkText());
    const secret = url.hash.slice(1);

    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    // The room reads the secret from the fragment, then strips it from the URL.
    expect(window.location.pathname).toBe(url.pathname);
    expect(window.location.search).toBe(url.search);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(secret);
  });
});
