import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  window.history.pushState(null, "", "/");
});

describe("App routing", () => {
  it("renders home at /", () => {
    window.history.pushState(null, "", "/");
    render(<App />);
    expect(screen.getByRole("button", { name: "Create chat" })).toBeTruthy();
  });

  it("serves the same generic room screen for every /r/* path", () => {
    // No fragment: the screen must be the generic "incomplete" one,
    // identical for every room, with no per-room metadata.
    window.history.pushState(null, "", "/r/aaaaaaaaaaaaaaaaaaaaaa");
    render(<App />);
    expect(screen.getByTestId("incomplete").textContent).toBe("This link is incomplete");
    // The generic screen must not echo any room or secret data.
    expect(screen.queryByTestId("invite-link")).toBeNull();
    expect(document.body.textContent).not.toContain("aaaaaaaaaaaaaaaaaaaaaa");
  });

  it("renders a fallback for unknown paths", () => {
    window.history.pushState(null, "", "/whatever");
    render(<App />);
    expect(screen.getByText("This link does not exist.")).toBeTruthy();
  });
});
