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

  it("rejects anything else", () => {
    expect(parseRoute("")).toEqual({ kind: "notFound" });
    expect(parseRoute("/r/")).toEqual({ kind: "notFound" });
    expect(parseRoute("/r/a/b")).toEqual({ kind: "notFound" });
    expect(parseRoute("/admin")).toEqual({ kind: "notFound" });
  });
});
