import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The protocol package must run unchanged in Node and in a browser,
 * so it may not use Node-only globals or modules in its source.
 */
const srcDir = fileURLToPath(new URL(".", import.meta.url));

describe("browser compatibility", () => {
  const files = readdirSync(srcDir).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("uses only web-standard APIs", () => {
    const forbidden = [
      /\bBuffer\b/,
      /\bprocess\./,
      /\brequire\s*\(/,
      /from\s+["']node:/,
      /\b__dirname\b/,
      /\bbtoa\s*\(/,
      /\batob\s*\(/,
    ];
    for (const name of files) {
      const content = readFileSync(join(srcDir, name), "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(content), `${name} must not match ${pattern}`).toBe(false);
      }
    }
  });
});
