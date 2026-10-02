import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Privacy guard tests (spec steps 2/8/11): these fail the build if the
 * client ever gains browser storage, inline styles, third-party requests,
 * or loses its noindex/no-referrer meta tags.
 */
// NB: pass the raw string — in the jsdom environment the global URL class
// is jsdom's, which Node's fileURLToPath refuses to accept.
const srcDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(srcDir, "..");

function sourceFiles(): string[] {
  return readdirSync(srcDir).filter(
    (name) =>
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.tsx"),
  );
}

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "browser storage APIs",
    pattern: /localStorage|sessionStorage|indexedDB|document\.cookie|cookieStore/,
  },
  { name: "inline style attributes", pattern: /style=\{|style="/ },
  { name: "network requests (fetch/XHR/beacon)", pattern: /XMLHttpRequest|sendBeacon|fetch\s*\(/ },
  { name: "service workers", pattern: /serviceWorker/ },
  { name: "absolute http(s) urls", pattern: /https?:\/\// },
  { name: "eval-like APIs", pattern: /\beval\s*\(|new Function\s*\(/ },
];

describe("client privacy guards", () => {
  const files = sourceFiles();

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it("never touches browser storage, inline styles or third parties", () => {
    for (const name of files) {
      const content = readFileSync(join(srcDir, name), "utf8");
      for (const { name: ruleName, pattern } of FORBIDDEN) {
        expect(pattern.test(content), `${name} must not contain ${ruleName}`).toBe(false);
      }
    }
  });

  it("index.html is generic, self-contained and noindex", () => {
    const html = readFileSync(join(webRoot, "index.html"), "utf8");
    expect(html).toMatch(/<meta\s+name="robots"\s+content="noindex,nofollow"\s*\/?>/);
    expect(html).toMatch(/<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/);
    // No third-party origins, fonts, analytics or images.
    expect(html).not.toMatch(/https?:\/\//);
    // Only self-hosted resources.
    for (const match of html.matchAll(/(?:src|href)="([^"]*)"/g)) {
      const target = match[1]!;
      expect(target.startsWith("/") || target.startsWith("#")).toBe(true);
    }
  });

  it("MESSAGE_VISIBLE_MS defaults to off", async () => {
    const { MESSAGE_VISIBLE_MS } = await import("./Chat");
    expect(MESSAGE_VISIBLE_MS).toBe(0);
  });
});
