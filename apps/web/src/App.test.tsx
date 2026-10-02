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
    window.history.pushState(
      null,
      "",
      "/r/aaaaaaaaaaaaaaaaaaaaaa#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    render(<App />);
    expect(screen.getByText("Opening chat…")).toBeTruthy();
    // The generic screen must not echo any room or secret data.
    expect(screen.queryByTestId("invite-link")).toBeNull();
  });

  it("renders a fallback for unknown paths", () => {
    window.history.pushState(null, "", "/whatever");
    render(<App />);
    expect(screen.getByText("This link does not exist.")).toBeTruthy();
  });
});
