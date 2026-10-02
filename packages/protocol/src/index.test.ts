import { describe, expect, it } from "vitest";
import * as protocol from "./index.js";

describe("protocol public API", () => {
  it("exports the expected surface", () => {
    const expected = [
      "base64UrlToBytes",
      "bytesToBase64Url",
      "decryptMessage",
      "deriveKeys",
      "encryptMessage",
      "generateLabel",
      "generateMessageId",
      "generatePeerId",
      "generateRoomId",
      "generateSecret",
      "pad",
      "parseClientFrame",
      "parsePayload",
      "parseServerFrame",
      "ProtocolError",
      "unpad",
    ];
    for (const name of expected) {
      expect(protocol, `missing export: ${name}`).toHaveProperty(name);
    }
  });
});
