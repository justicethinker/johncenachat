import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index.js";

describe("skeleton", () => {
  it("loads the protocol package", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
