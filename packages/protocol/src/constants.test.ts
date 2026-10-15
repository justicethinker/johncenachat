import { describe, expect, it } from "vitest";
import { MAX_PEERS, MAX_PEERS_CEILING } from "./constants.js";

describe("group size limits", () => {
  it("keeps the default cap a real group (at least two people) within the hard ceiling", () => {
    expect(MAX_PEERS).toBeGreaterThanOrEqual(2);
    expect(MAX_PEERS).toBeLessThanOrEqual(MAX_PEERS_CEILING);
  });

  it("sets the hard ceiling to 50", () => {
    expect(MAX_PEERS_CEILING).toBe(50);
  });
});
