import { describe, expect, it } from "vitest";
import { canonicalQuery, encodeKeyPath, signRequest } from "./sigv4";

const creds = {
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  now: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
};
const host = "examplebucket.s3.amazonaws.com";
const sig = (h: Record<string, string>) => /Signature=([0-9a-f]{64})$/.exec(h.authorization)?.[1];

describe("signRequest (AWS examples)", () => {
  it("GET Object with a Range header", async () => {
    const h = await signRequest({ ...creds, method: "GET", host, path: "/test.txt", query: [], headers: { Range: "bytes=0-9" }, body: "" });
    expect(sig(h)).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(h.authorization).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,");
    expect(h["x-amz-content-sha256"]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(h.host).toBeUndefined();
  });

  it("PUT Object with a body and an encoded key", async () => {
    const h = await signRequest({
      ...creds,
      method: "PUT",
      host,
      path: `/${encodeKeyPath("test$file.text")}`,
      query: [],
      headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      body: "Welcome to Amazon S3.",
    });
    expect(sig(h)).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("GET Bucket (list) with query parameters", async () => {
    const h = await signRequest({ ...creds, method: "GET", host, path: "/", query: [["prefix", "J"], ["max-keys", "2"]], headers: {}, body: "" });
    expect(sig(h)).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });
});

describe("encoding", () => {
  it("encodes key segments per RFC 3986 and keeps slashes", () => {
    expect(encodeKeyPath("team vault/é(1)*!.b64")).toBe("team%20vault/%C3%A9%281%29%2A%21.b64");
  });
  it("sorts query parameters by encoded name", () => {
    expect(canonicalQuery([["prefix", "a b/"], ["list-type", "2"], ["continuation-token", "x+y"]])).toBe(
      "continuation-token=x%2By&list-type=2&prefix=a%20b%2F",
    );
  });
});
