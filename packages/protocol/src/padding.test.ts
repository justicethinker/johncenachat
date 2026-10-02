import { describe, expect, it } from "vitest";
import { PAD_BUCKETS } from "./constants.js";
import { ProtocolError } from "./errors.js";
import { pad, unpad } from "./padding.js";

function bytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (i * 7 + 13) & 0xff;
  }
  return out;
}

describe("padding", () => {
  it("produces only the three allowed bucket sizes", () => {
    for (const len of [0, 1, 100, 254, 255, 500, 1022, 1023, 2000, 4094]) {
      const padded = pad(bytes(len));
      expect(PAD_BUCKETS).toContain(padded.length);
    }
  });

  it("selects the smallest fitting bucket", () => {
    expect(pad(bytes(0)).length).toBe(256);
    expect(pad(bytes(254)).length).toBe(256);
    expect(pad(bytes(255)).length).toBe(1024);
    expect(pad(bytes(1022)).length).toBe(1024);
    expect(pad(bytes(1023)).length).toBe(4096);
    expect(pad(bytes(4094)).length).toBe(4096);
  });

  it("rejects input larger than the biggest bucket", () => {
    expect(() => pad(bytes(4095))).toThrow(ProtocolError);
    expect(() => pad(bytes(10_000))).toThrow(ProtocolError);
    try {
      pad(bytes(4095));
    } catch (error) {
      expect((error as ProtocolError).code).toBe("too_large");
    }
  });

  it("round trips through pad/unpad", () => {
    for (const len of [0, 1, 42, 254, 255, 1000, 1022, 1023, 4094]) {
      const original = bytes(len);
      expect(unpad(pad(original))).toEqual(original);
    }
  });

  it("is zero-padded to the full bucket", () => {
    const padded = pad(bytes(4));
    for (let i = 6; i < padded.length; i++) {
      expect(padded[i]).toBe(0);
    }
  });

  it("rejects malformed padded data", () => {
    // Not a bucket size.
    expect(() => unpad(bytes(300))).toThrow(ProtocolError);
    // Length prefix beyond bucket.
    const badLength = pad(bytes(10));
    badLength[0] = 0xff;
    badLength[1] = 0xff;
    expect(() => unpad(badLength)).toThrow(ProtocolError);
    // Non-zero padding after the payload.
    const dirty = pad(bytes(10));
    dirty[dirty.length - 1] = 1;
    expect(() => unpad(dirty)).toThrow(ProtocolError);
  });
});
