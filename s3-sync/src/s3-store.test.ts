import { describe, expect, it } from "vitest";
import { fakeHttp, type RecordedRequest } from "../../shared/vault-sync/src/testing/fakes";
import type { S3Config } from "./config";
import { S3Store } from "./s3-store";

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

  it("rethrows the original PUT error when the read-back after a non-conflict failure finds nothing", async () => {
    const { s } = store((r) =>
      r.method === "PUT"
        ? { status: 501, body: `HTTP 501: ${errXml("NotImplemented")}` }
        : { status: 404, body: `HTTP 404: ${errXml("NoSuchKey")}` },
    );
    await expect(s.createSalt(salt)).rejects.toMatchObject({ kind: "other", status: 501 });
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

  it("delete ignores 404 but not NoSuchBucket", async () => {
    const { s, requests } = store(() => ({ status: 404, body: "" }));
    await s.deleteDevice("a");
    expect(requests.map((r) => r.method)).toEqual(["DELETE", "DELETE"]);

    const { s: s2 } = store(() => ({ status: 404, body: `HTTP 404: ${errXml("NoSuchBucket")}` }));
    await expect(s2.deleteDevice("a")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("maps a signature failure to auth", async () => {
    const { s } = store(() => ({ status: 403, body: `HTTP 403: ${errXml("SignatureDoesNotMatch")}` }));
    await expect(s.getDevice("a")).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("S3Store probe", () => {
  it("names the failing step", async () => {
    const { s } = store((r) => (r.method === "PUT" ? { status: 200 } : { status: 403, body: `HTTP 403: ${errXml("AccessDenied")}` }));
    await expect(s.probe()).rejects.toThrow(/^Read test failed: /);
  });
});
