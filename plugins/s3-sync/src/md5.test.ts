import { describe, expect, it } from "vitest";
import { md5, md5Base64 } from "./md5";

type NodeHash = { update(s: string, enc: "utf8"): NodeHash; digest(enc: "hex" | "base64"): string };
const nodeCrypto = "node:crypto";
const { createHash } = (await import(nodeCrypto)) as { createHash(alg: "md5"): NodeHash };
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("md5", () => {
  it.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
    ["1234567890".repeat(8), "57edf4a22be3c955ac49da2e2107b67a"],
  ])("RFC 1321 vector %j", (input, expected) => {
    expect(hex(md5(input))).toBe(expected);
  });

  it("hashes the UTF-8 bytes of a multi-byte string", () => {
    const input = "équipe vault/é — 日本語 🔐".repeat(5);
    expect(hex(md5(input))).toBe(createHash("md5").update(input, "utf8").digest("hex"));
    expect(md5Base64(input)).toBe(createHash("md5").update(input, "utf8").digest("base64"));
  });
});
