import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url, isBase64Url, isBase64UrlOfLength } from "./base64.js";
import { ProtocolError } from "./errors.js";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

describe("base64url", () => {
  it("matches known vectors", () => {
    expect(bytesToBase64Url(new TextEncoder().encode("foobar"))).toBe("Zm9vYmFy");
    expect(bytesToBase64Url(new Uint8Array([0xff]))).toBe("_w");
    expect(bytesToBase64Url(new Uint8Array([0xff, 0xff]))).toBe("__8");
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(bytesToBase64Url(new Uint8Array(0))).toBe("");
  });

  it("round trips arbitrary bytes", () => {
    for (let length = 0; length <= 64; length++) {
      const original = randomBytes(length);
      const encoded = bytesToBase64Url(original);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(base64UrlToBytes(encoded)).toEqual(original);
    }
  });

  it("rejects invalid characters and lengths", () => {
    expect(() => base64UrlToBytes("ab+c")).toThrow(ProtocolError);
    expect(() => base64UrlToBytes("ab/c")).toThrow(ProtocolError);
    expect(() => base64UrlToBytes("abc=")).toThrow(ProtocolError);
    expect(() => base64UrlToBytes("a")).toThrow(ProtocolError); // length % 4 === 1
    expect(() => base64UrlToBytes("abcde")).toThrow(ProtocolError); // length % 4 === 1
  });

  it("rejects non-canonical encodings", () => {
    // Leftover bits must be zero.
    expect(() => base64UrlToBytes("AB")).toThrow(ProtocolError);
    expect(base64UrlToBytes("AA")).toEqual(new Uint8Array([0]));
  });

  it("isBase64Url validates without throwing", () => {
    expect(isBase64Url("Zm9vYmFy")).toBe(true);
    expect(isBase64Url("")).toBe(true);
    expect(isBase64Url("nope!")).toBe(false);
    expect(isBase64Url(42)).toBe(false);
    expect(isBase64UrlOfLength("Zm9vYmFy", 6)).toBe(true);
    expect(isBase64UrlOfLength("Zm9vYmFy", 5)).toBe(false);
  });
});
