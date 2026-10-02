import { describe, expect, it } from "vitest";
import { ProtocolError } from "./errors.js";
import { assertPayload, parsePayload } from "./payload.js";
import { generateMessageId } from "./random.js";

const encoder = new TextEncoder();

function encode(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

describe("payload validation", () => {
  it("accepts a minimal payload", () => {
    const payload = { id: generateMessageId(), text: "hi" };
    expect(assertPayload(payload)).toBeUndefined();
    expect(parsePayload(encode(payload))).toEqual(payload);
  });

  it("accepts a payload with re", () => {
    const payload = { id: generateMessageId(), text: "hi", re: generateMessageId() };
    expect(parsePayload(encode(payload))).toEqual(payload);
  });

  it("rejects unknown keys (no metadata may ride along)", () => {
    const payload = { id: generateMessageId(), text: "hi", ts: 123456 };
    expect(parsePayload(encode(payload))).toBeNull();
    expect(() => assertPayload(payload)).toThrow(ProtocolError);
  });

  it("rejects a bad id or re", () => {
    expect(parsePayload(encode({ id: "short", text: "hi" }))).toBeNull();
    expect(parsePayload(encode({ id: 42, text: "hi" }))).toBeNull();
    expect(parsePayload(encode({ id: generateMessageId(), text: "hi", re: "nope" }))).toBeNull();
  });

  it("rejects text over the character limit", () => {
    expect(parsePayload(encode({ id: generateMessageId(), text: "a".repeat(1501) }))).toBeNull();
    expect(
      parsePayload(encode({ id: generateMessageId(), text: "a".repeat(1500) })),
    ).not.toBeNull();
  });

  it("rejects non-strings, arrays and invalid JSON", () => {
    expect(parsePayload(encoder.encode("[]"))).toBeNull();
    expect(parsePayload(encoder.encode('"str"'))).toBeNull();
    expect(parsePayload(encoder.encode("null"))).toBeNull();
    expect(parsePayload(encoder.encode("{not json"))).toBeNull();
    expect(parsePayload(encoder.encode("{}"))).toBeNull();
    expect(parsePayload(encoder.encode('{"id":1,"text":2}'))).toBeNull();
  });
});
