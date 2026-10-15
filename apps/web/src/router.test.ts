import { describe, expect, it } from "vitest";
import { parseRoute } from "./router";

describe("parseRoute", () => {
  it("recognises home", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
  });

  it("recognises a room", () => {
    expect(parseRoute("/r/abcDEF1234567890_-xy")).toEqual({
      kind: "room",
      roomId: "abcDEF1234567890_-xy",
    });
    expect(parseRoute("/r/abc/")).toEqual({ kind: "room", roomId: "abc" });
  });

  it("recognises quick start with and without a count", () => {
    expect(parseRoute("/new")).toEqual({ kind: "quickStart", count: null });
    expect(parseRoute("/new/")).toEqual({ kind: "quickStart", count: null });
    expect(parseRoute("/new/4")).toEqual({ kind: "quickStart", count: 4 });
    expect(parseRoute("/new/99")).toEqual({ kind: "quickStart", count: 99 });
    expect(parseRoute("/new/1")).toEqual({ kind: "quickStart", count: 1 });
  });

  it("leaves non-numeric quick start counts for the picker to reject", () => {
    expect(parseRoute("/new/abc")).toEqual({ kind: "quickStart", count: null });
    expect(parseRoute("/new/4.5")).toEqual({ kind: "quickStart", count: null });
    expect(parseRoute("/new/-2")).toEqual({ kind: "quickStart", count: null });
  });

  it("rejects anything else", () => {
    expect(parseRoute("")).toEqual({ kind: "notFound" });
    expect(parseRoute("/r/")).toEqual({ kind: "notFound" });
    expect(parseRoute("/r/a/b")).toEqual({ kind: "notFound" });
    expect(parseRoute("/admin")).toEqual({ kind: "notFound" });
    expect(parseRoute("/new/4/5")).toEqual({ kind: "notFound" });
    expect(parseRoute("/newer")).toEqual({ kind: "notFound" });
  });
});
