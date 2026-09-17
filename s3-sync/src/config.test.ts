import { describe, expect, it } from "vitest";
import { isPrivateHost, normalizeEndpoint, normalizePrefix, validateBucket } from "./config";

describe("normalizeEndpoint", () => {
  it("keeps scheme, host and port only", () => {
    expect(normalizeEndpoint(" https://s3.eu-central-1.amazonaws.com/ ")).toBe("https://s3.eu-central-1.amazonaws.com");
    expect(normalizeEndpoint("http://192.168.1.20:9000")).toBe("http://192.168.1.20:9000");
  });
  it("rejects a path, public http and garbage", () => {
    expect(() => normalizeEndpoint("https://host/bucket")).toThrow(/path/);
    expect(() => normalizeEndpoint("http://s3.example.com")).toThrow(/https/);
    expect(() => normalizeEndpoint("nope")).toThrow(/valid URL/);
    expect(() => normalizeEndpoint("")).toThrow(/required/);
  });
});

describe("isPrivateHost", () => {
  it.each(["localhost", "127.0.0.1", "10.2.3.4", "172.20.0.1", "192.168.0.9", "[::1]", "nas.local"])("%s is private", (h) =>
    expect(isPrivateHost(h)).toBe(true),
  );
  it.each(["172.32.0.1", "8.8.8.8", "s3.amazonaws.com"])("%s is public", (h) => expect(isPrivateHost(h)).toBe(false));
});

describe("normalizePrefix", () => {
  it("trims slashes and adds one trailing slash", () => {
    expect(normalizePrefix("")).toBe("");
    expect(normalizePrefix(" /voltius/team/ ")).toBe("voltius/team/");
  });
});

describe("validateBucket", () => {
  it("accepts S3 bucket names and rejects others", () => {
    expect(() => validateBucket("voltius-vault.sync")).not.toThrow();
    expect(() => validateBucket("Bad_Bucket")).toThrow();
    expect(() => validateBucket("ab")).toThrow();
  });
});
