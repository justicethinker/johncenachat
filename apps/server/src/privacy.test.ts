import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The server must never log: no request logs, no connection logs, no IPs,
 * no room ids (spec section 7). console.error is tolerated only in index.ts
 * for fatal startup errors.
 */
const srcDir = fileURLToPath(new URL(".", import.meta.url));

const VERBOSE_CONSOLE =
  /console\.(log|info|debug|warn|trace|assert|dir|table|time|timeEnd|group|groupEnd)\s*\(/;
const ANY_CONSOLE = /console\s*\.\s*[A-Za-z_$]+\s*\(/;

describe("zero logging", () => {
  const files = readdirSync(srcDir).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("never uses verbose console output anywhere", () => {
    for (const name of files) {
      const content = readFileSync(join(srcDir, name), "utf8");
      expect(VERBOSE_CONSOLE.test(content), `${name} must not log verbosely`).toBe(false);
    }
  });

  it("uses console.error only in index.ts (fatal startup errors)", () => {
    for (const name of files) {
      const content = readFileSync(join(srcDir, name), "utf8");
      if (name === "index.ts") continue;
      expect(ANY_CONSOLE.test(content), `${name} must not call console at all`).toBe(false);
    }
  });

  it("never mentions room ids in index.ts", () => {
    const content = readFileSync(join(srcDir, "index.ts"), "utf8");
    expect(content).not.toMatch(/roomId|room_id/i);
  });
});
