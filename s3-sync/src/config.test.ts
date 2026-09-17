import { describe, expect, it } from "vitest";
import { fakeApi } from "../../shared/vault-sync/src/testing/fakes";
import {
  isPrivateHost,
  loadS3Config,
  normalizeEndpoint,
  normalizePrefix,
  STORAGE_KEYS,
  toConfigValues,
  validateBucket,
  VAULT_KEYS,
  type S3Config,
} from "./config";

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
  it("rejects a \".\" or \"..\" segment", () => {
    expect(() => normalizePrefix("./voltius")).toThrow(/segment/);
    expect(() => normalizePrefix("voltius/../x")).toThrow(/segment/);
    expect(() => normalizePrefix("voltius/..")).toThrow(/segment/);
  });
});

describe("validateBucket", () => {
  it("accepts S3 bucket names and rejects others", () => {
    expect(() => validateBucket("voltius-vault.sync")).not.toThrow();
    expect(() => validateBucket("Bad_Bucket")).toThrow();
    expect(() => validateBucket("ab")).toThrow();
  });
});

const fullConfig: S3Config = {
  endpoint: "https://s3.eu-central-1.amazonaws.com",
  region: "eu-central-1",
  bucket: "voltius-vault-sync",
  prefix: "voltius/team/",
  addressing: "virtual",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "s3cr3t",
};

function populate(storage: Map<string, unknown>, vault: Map<string, string>, cfg: S3Config, omit?: string) {
  const cv = toConfigValues(cfg);
  for (const k of STORAGE_KEYS) if (k !== omit) storage.set(k, cv.storage[k]);
  for (const k of VAULT_KEYS) if (k !== omit) vault.set(k, cv.vault[k]);
}

describe("toConfigValues", () => {
  it("maps storage and vault keys exactly to STORAGE_KEYS/VAULT_KEYS", () => {
    const cv = toConfigValues(fullConfig);
    expect(Object.keys(cv.storage).sort()).toEqual([...STORAGE_KEYS].sort());
    expect(Object.keys(cv.vault).sort()).toEqual([...VAULT_KEYS].sort());
    expect(cv.storage.s3Endpoint).toBe(fullConfig.endpoint);
    expect(cv.storage.s3Region).toBe(fullConfig.region);
    expect(cv.storage.s3Bucket).toBe(fullConfig.bucket);
    expect(cv.storage.s3Prefix).toBe(fullConfig.prefix);
    expect(cv.storage.s3Addressing).toBe(fullConfig.addressing);
    expect(cv.vault.s3AccessKeyId).toBe(fullConfig.accessKeyId);
    expect(cv.vault.s3SecretAccessKey).toBe(fullConfig.secretAccessKey);
  });
});

describe("loadS3Config", () => {
  it("round-trips a full config through toConfigValues", async () => {
    const { api, storage, vault } = fakeApi();
    populate(storage, vault, fullConfig);
    await expect(loadS3Config(api)).resolves.toEqual(fullConfig);
  });

  it.each(["s3Endpoint", "s3Bucket", "s3AccessKeyId", "s3SecretAccessKey"])("returns null when %s is missing", async (key) => {
    const { api, storage, vault } = fakeApi();
    populate(storage, vault, fullConfig, key);
    await expect(loadS3Config(api)).resolves.toBeNull();
  });

  it("defaults region and prefix to empty string and addressing to path when absent", async () => {
    const { api, storage, vault } = fakeApi();
    storage.set("s3Endpoint", fullConfig.endpoint);
    storage.set("s3Bucket", fullConfig.bucket);
    vault.set("s3AccessKeyId", fullConfig.accessKeyId);
    vault.set("s3SecretAccessKey", fullConfig.secretAccessKey);
    await expect(loadS3Config(api)).resolves.toEqual({
      ...fullConfig,
      region: "",
      prefix: "",
      addressing: "path",
    });
  });

  it("defaults addressing to path for an unknown stored value", async () => {
    const { api, storage, vault } = fakeApi();
    populate(storage, vault, fullConfig);
    storage.set("s3Addressing", "bogus");
    await expect(loadS3Config(api)).resolves.toMatchObject({ addressing: "path" });
  });
});
