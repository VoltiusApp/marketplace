import { describe, expect, it } from "vitest";
import { fakeHttp, type RecordedRequest } from "../../shared/vault-sync/src/testing/fakes";
import type { S3Config } from "./config";
import { md5Base64 } from "./md5";
import { PROBE_KEY, S3Store } from "./s3-store";

const cfg: S3Config = {
  endpoint: "http://127.0.0.1:9000",
  region: "",
  bucket: "vault",
  prefix: "team/",
  addressing: "path",
  accessKeyId: "AK",
  secretAccessKey: "SK",
};
const errXml = (code: string) => `<Error><Code>${code}</Code><Message>m</Message></Error>`;
const salt = "d".repeat(32);

function store(handler: (r: RecordedRequest) => { status: number; body?: string }, over: Partial<S3Config> = {}) {
  const f = fakeHttp(handler);
  return { s: new S3Store(f.http, { ...cfg, ...over }, () => new Date(Date.UTC(2026, 8, 17))), requests: f.requests };
}

describe("S3Store addressing", () => {
  it("path-style puts the bucket in the path and signs with us-east-1 by default", async () => {
    const { s, requests } = store(() => ({ status: 404, body: `HTTP 404: ${errXml("NoSuchKey")}` }));
    expect(await s.readSalt()).toBeNull();
    expect(requests[0].url).toBe("http://127.0.0.1:9000/vault/team/vault.json");
    expect(requests[0].headers.authorization).toContain("/us-east-1/s3/aws4_request");
  });

  it("virtual-hosted puts the bucket in the host", async () => {
    const { s, requests } = store(() => ({ status: 200, body: JSON.stringify({ schema: 1, salt }) }), {
      endpoint: "https://s3.eu-west-3.amazonaws.com",
      addressing: "virtual",
      region: "eu-west-3",
    });
    expect(await s.readSalt()).toBe(salt);
    expect(requests[0].url).toBe("https://vault.s3.eu-west-3.amazonaws.com/team/vault.json");
  });

  it("rejects an invalid bucket name", () => {
    const { http } = fakeHttp(() => ({ status: 200 }));
    expect(() => new S3Store(http, { ...cfg, bucket: "AB" })).toThrow(/bucket/);
  });

  it("rejects a dotted bucket with virtual-hosted https", () => {
    const { http } = fakeHttp(() => ({ status: 200 }));
    expect(
      () => new S3Store(http, { ...cfg, bucket: "a.b", addressing: "virtual", endpoint: "https://s3.eu-west-3.amazonaws.com" }),
    ).toThrow(/dots/);
  });

  it("percent-encodes a prefix and key with spaces and accents, and signs the encoded path", async () => {
    const { s, requests } = store(() => ({ status: 200 }), { prefix: "team vault/é" });
    await s.putDevice("dev-1.bak", "B", { label: "L", pushedAt: "t" });
    expect(requests[0].url).toBe("http://127.0.0.1:9000/vault/team%20vault/%C3%A9/devices/dev-1.bak.b64");
    expect(requests[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//);
  });
});

describe("S3Store salt", () => {
  it("creates with If-None-Match and returns the stored salt", async () => {
    let stored: string | null = null;
    const { s, requests } = store((r) => {
      if (r.method === "PUT") {
        stored = r.body!;
        return { status: 200 };
      }
      return { status: 200, body: stored! };
    });
    expect(await s.createSalt(salt)).toBe(salt);
    expect(requests[0].headers["if-none-match"]).toBe("*");
  });

  it("signs content-type and if-none-match, not just sends them", async () => {
    let stored: string | null = null;
    const { s, requests } = store((r) => {
      if (r.method === "PUT") {
        stored = r.body!;
        return { status: 200 };
      }
      return { status: 200, body: stored! };
    });
    await s.createSalt(salt);
    expect(requests[0].headers.authorization).toContain(
      "SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date",
    );
  });

  it("keeps the existing salt on 412", async () => {
    const existing = "e".repeat(32);
    const { s } = store((r) =>
      r.method === "PUT"
        ? { status: 412, body: `HTTP 412: ${errXml("PreconditionFailed")}` }
        : { status: 200, body: JSON.stringify({ schema: 1, salt: existing }) },
    );
    expect(await s.createSalt(salt)).toBe(existing);
  });

  it("recovers from a non-conflict PUT rejection if a valid vault already exists", async () => {
    const existing = "e".repeat(32);
    const { s } = store((r) =>
      r.method === "PUT"
        ? { status: 501, body: `HTTP 501: ${errXml("NotImplemented")}` }
        : { status: 200, body: JSON.stringify({ schema: 1, salt: existing }) },
    );
    expect(await s.createSalt(salt)).toBe(existing);
  });

  it.each([
    [400, "InvalidArgument"],
    [501, "NotImplemented"],
  ])("retries once without If-None-Match when the provider rejects it with %i %s", async (status, code) => {
    let stored: string | null = null;
    const { s, requests } = store((r) => {
      if (r.method === "PUT") {
        if (r.headers["if-none-match"]) return { status, body: `HTTP ${status}: ${errXml(code)}` };
        stored = r.body!;
        return { status: 200 };
      }
      return stored === null ? { status: 404, body: `HTTP 404: ${errXml("NoSuchKey")}` } : { status: 200, body: stored };
    });
    expect(await s.createSalt(salt)).toBe(salt);
    const puts = requests.filter((r) => r.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[1].headers["if-none-match"]).toBeUndefined();
    expect(puts[1].headers.authorization).not.toContain("if-none-match");
  });

  it("rethrows a non-conflict PUT error with another status when the read-back finds nothing", async () => {
    const { s, requests } = store((r) =>
      r.method === "PUT"
        ? { status: 500, body: `HTTP 500: ${errXml("InternalError")}` }
        : { status: 404, body: `HTTP 404: ${errXml("NoSuchKey")}` },
    );
    await expect(s.createSalt(salt)).rejects.toMatchObject({ kind: "other", status: 500 });
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("never retries over a vault.json that is not a Voltius vault", async () => {
    const { s, requests } = store((r) =>
      r.method === "PUT" ? { status: 400, body: `HTTP 400: ${errXml("InvalidArgument")}` } : { status: 200, body: "{}" },
    );
    await expect(s.createSalt(salt)).rejects.toMatchObject({ kind: "other", status: 400 });
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("propagates a non-conflict, non-recoverable PUT error instead of swallowing it", async () => {
    const { s } = store(() => ({ status: 403, body: `HTTP 403: ${errXml("AccessDenied")}` }));
    await expect(s.createSalt(salt)).rejects.toMatchObject({ kind: "auth" });
  });

  it("throws when the vault cannot be read back after a successful write", async () => {
    const { s } = store((r) =>
      r.method === "PUT" ? { status: 200 } : { status: 404, body: `HTTP 404: ${errXml("NoSuchKey")}` },
    );
    await expect(s.createSalt(salt)).rejects.toMatchObject({ kind: "other" });
  });

  it("rejects a vault.json that is not a Voltius vault", async () => {
    const { s } = store(() => ({ status: 200, body: "{}" }));
    await expect(s.readSalt()).rejects.toMatchObject({ kind: "other" });
  });

  it("maps NoSuchBucket to not_found, not to an empty vault", async () => {
    const { s } = store(() => ({ status: 404, body: `HTTP 404: ${errXml("NoSuchBucket")}` }));
    await expect(s.readSalt()).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("S3Store devices", () => {
  it("lists .b64 objects across pages and skips anything else", async () => {
    const page1 = `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken>
<Contents><Key>team/devices/a.b64</Key><ETag>"1"</ETag></Contents>
<Contents><Key>team/devices/a.json</Key><ETag>"x"</ETag></Contents></ListBucketResult>`;
    const page2 = `<ListBucketResult><IsTruncated>false</IsTruncated>
<Contents><Key>team/devices/b.b64</Key><ETag>"2"</ETag></Contents>
<Contents><Key>team/devices/nested/c.b64</Key><ETag>"3"</ETag></Contents></ListBucketResult>`;
    const { s, requests } = store((r) => ({ status: 200, body: r.url.includes("continuation-token=t2") ? page2 : page1 }));
    expect(await s.listDevices()).toEqual([
      { id: "a", version: "1" },
      { id: "b", version: "2" },
    ]);
    expect(requests[0].url).toBe("http://127.0.0.1:9000/vault?list-type=2&prefix=team%2Fdevices%2F");
  });

  it("versions a device without an ETag by LastModified and Size", async () => {
    const list = (modified: string, size: number) =>
      `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>team/devices/a.b64</Key><LastModified>${modified}</LastModified><Size>${size}</Size></Contents></ListBucketResult>`;
    let body = list("2026-09-17T00:00:00.000Z", 10);
    const { s } = store(() => ({ status: 200, body }));
    const [first] = await s.listDevices();
    expect(first).toEqual({ id: "a", version: "2026-09-17T00:00:00.000Z:10" });
    body = list("2026-09-17T00:01:00.000Z", 10);
    const [second] = await s.listDevices();
    expect(second.version).not.toBe(first.version);
  });

  it("writes the blob before its metadata", async () => {
    const { s, requests } = store(() => ({ status: 200 }));
    await s.putDevice("a", "BLOB", { label: "Laptop", pushedAt: "2026-09-17T00:00:00.000Z" });
    expect(requests.map((r) => r.url.split("/").pop())).toEqual(["a.b64", "a.json"]);
    expect(JSON.parse(requests[1].body!)).toEqual({ label: "Laptop", pushedAt: "2026-09-17T00:00:00.000Z" });
  });

  it("describes devices with a fallback for missing metadata", async () => {
    const list = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>team/devices/a.b64</Key><ETag>"1"</ETag></Contents></ListBucketResult>`;
    const { s } = store((r) => (r.url.includes("list-type") ? { status: 200, body: list } : { status: 404, body: "" }));
    expect(await s.describeDevices()).toEqual([{ id: "a", label: "a", pushedAt: "" }]);
  });

  it("falls back per-device when a device's metadata GET fails with a real error, not just 404", async () => {
    const list = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>team/devices/a.b64</Key><ETag>"1"</ETag></Contents></ListBucketResult>`;
    const { s } = store((r) =>
      r.url.includes("list-type") ? { status: 200, body: list } : { status: 500, body: `HTTP 500: ${errXml("InternalError")}` },
    );
    expect(await s.describeDevices()).toEqual([{ id: "a", label: "a", pushedAt: "" }]);
  });

  it("maps a signature failure to auth", async () => {
    const { s } = store(() => ({ status: 403, body: `HTTP 403: ${errXml("SignatureDoesNotMatch")}` }));
    await expect(s.getDevice("a")).rejects.toMatchObject({ kind: "auth" });
  });

  it("rejects a device id that would be filtered out of listDevices", async () => {
    const { s } = store(() => ({ status: 200 }));
    await expect(s.putDevice("bad/id", "B", { label: "L", pushedAt: "t" })).rejects.toMatchObject({ kind: "other" });
    await expect(s.getDevice("bad/id")).rejects.toMatchObject({ kind: "other" });
  });

  it("rejects an invalid device id on delete without sending anything", async () => {
    const { s, requests } = store(() => ({ status: 200, body: "<DeleteResult/>" }));
    await expect(s.deleteDevice("../vault")).rejects.toMatchObject({ kind: "other" });
    expect(requests).toEqual([]);
  });

  it("GET never sends a body; PUT sends exactly the signed body", async () => {
    const { s, requests } = store(() => ({ status: 200 }));
    await s.getDevice("a");
    await s.putDevice("a", "BLOB", { label: "L", pushedAt: "t" });
    expect(requests[0].body).toBeUndefined();
    expect(requests[1].body).toBe("BLOB");
    expect(requests[2].body).toBe(JSON.stringify({ label: "L", pushedAt: "t" }));
  });
});

const deleteBody = (...keys: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${keys.map((k) => `<Object><Key>${k}</Key></Object>`).join("")}</Delete>`;

describe("S3Store delete", () => {
  it("deletes a device's blob and metadata in one signed DeleteObjects POST", async () => {
    const { s, requests } = store(() => ({ status: 200, body: "<DeleteResult></DeleteResult>" }));
    await s.deleteDevice("a");
    expect(requests).toHaveLength(1);
    const [r] = requests;
    expect(r.method).toBe("POST");
    expect(r.url).toBe("http://127.0.0.1:9000/vault?delete=");
    expect(r.body).toBe(deleteBody("team/devices/a.b64", "team/devices/a.json"));
    expect(r.headers["content-md5"]).toBe(md5Base64(r.body!));
    expect(r.headers["content-type"]).toBe("application/xml");
    expect(r.headers.authorization).toContain("SignedHeaders=content-md5;content-type;host;x-amz-content-sha256;x-amz-date,");
  });

  it("targets the bucket host root when virtual-hosted and XML-escapes keys", async () => {
    const { s, requests } = store(() => ({ status: 200, body: "<DeleteResult/>" }), {
      endpoint: "https://s3.eu-west-3.amazonaws.com",
      addressing: "virtual",
      prefix: "a&b<c>'\"",
    });
    await s.deleteDevice("a");
    expect(requests[0].url).toBe("https://vault.s3.eu-west-3.amazonaws.com/?delete=");
    expect(requests[0].body).toBe(
      deleteBody("a&amp;b&lt;c&gt;&apos;&quot;/devices/a.b64", "a&amp;b&lt;c&gt;&apos;&quot;/devices/a.json"),
    );
  });

  it("throws the mapped kind when the 200 DeleteResult reports a failed key", async () => {
    const body = `<DeleteResult><Error><Key>team/devices/a.json</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error></DeleteResult>`;
    const { s } = store(() => ({ status: 200, body }));
    await expect(s.deleteDevice("a")).rejects.toMatchObject({ kind: "auth" });

    const other = `<DeleteResult><Error><Key>team/devices/a.b64</Key><Code>InternalError</Code><Message>boom</Message></Error></DeleteResult>`;
    const { s: s2 } = store(() => ({ status: 200, body: other }));
    await expect(s2.deleteDevice("a")).rejects.toMatchObject({ kind: "other", message: expect.stringContaining("InternalError") });
  });

  it("maps a missing bucket to not_found", async () => {
    const { s } = store(() => ({ status: 404, body: `HTTP 404: ${errXml("NoSuchBucket")}` }));
    await expect(s.deleteDevice("a")).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("S3Store probe", () => {
  it("names the failing step and preserves the StoreError kind", async () => {
    const { s } = store((r) => (r.method === "PUT" ? { status: 200 } : { status: 403, body: `HTTP 403: ${errXml("AccessDenied")}` }));
    await expect(s.probe()).rejects.toThrow(/^Read test failed: /);
    await expect(s.probe()).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("S3Store never triggers a null-body status", () => {
  it("probe deletes through DeleteObjects", async () => {
    const { s, requests } = store((r) => (r.method === "GET" ? { status: 200, body: "ok" } : { status: 200 }));
    await s.probe();
    expect(requests.map((r) => r.method)).toEqual(["PUT", "GET", "POST"]);
    expect(requests[2].url).toBe("http://127.0.0.1:9000/vault?delete=");
    expect(requests[2].body).toBe(deleteBody(`team/${PROBE_KEY}`));
  });

  it("no operation sends DELETE", async () => {
    const objects = new Map<string, string>();
    const { s, requests } = store((r) => {
      const url = new URL(r.url);
      if (r.method === "PUT") {
        objects.set(url.pathname, r.body!);
        return { status: 200 };
      }
      if (r.method === "POST") return { status: 200, body: "<DeleteResult/>" };
      if (url.searchParams.has("list-type")) {
        const keys = [...objects.keys()].filter((k) => k.endsWith(".b64")).map((k) => k.replace("/vault/", ""));
        return {
          status: 200,
          body: `<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key><ETag>"1"</ETag></Contents>`).join("")}</ListBucketResult>`,
        };
      }
      const hit = objects.get(url.pathname);
      return hit === undefined ? { status: 404, body: `HTTP 404: ${errXml("NoSuchKey")}` } : { status: 200, body: hit };
    });
    await s.probe();
    await s.createSalt(salt);
    await s.putDevice("a", "BLOB", { label: "L", pushedAt: "t" });
    expect(await s.describeDevices()).toEqual([{ id: "a", label: "L", pushedAt: "t" }]);
    await s.deleteDevice("a");
    expect(requests.length).toBeGreaterThan(5);
    expect(requests.filter((r) => r.method !== "GET" && r.method !== "PUT" && r.method !== "POST")).toEqual([]);
  });
});
