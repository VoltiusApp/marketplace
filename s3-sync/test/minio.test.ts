import { beforeAll, describe, expect, it } from "vitest";
import type { Http } from "../../shared/vault-sync/src/http";
import type { S3Config } from "../src/config";
import { S3Store } from "../src/s3-store";
import { signRequest } from "../src/sigv4";

declare const process: { env: Record<string, string | undefined> };

const endpoint = process.env.MINIO_ENDPOINT;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const http = {
  stream: async (url: string, init?: RequestInit) => {
    const res = await fetch(url, init);
    // Released hosts' bridge builds `new Response(body, { status })`, which throws for these.
    if (NULL_BODY_STATUSES.has(res.status)) throw new Error(`${init?.method ?? "GET"} ${url} returned ${res.status}`);
    return res;
  },
} as unknown as Http;
const bucket = `vs-${Date.now()}`;
const base = (): S3Config => ({
  endpoint: endpoint!,
  region: "",
  bucket,
  prefix: "",
  addressing: "path",
  accessKeyId: process.env.MINIO_USER!,
  secretAccessKey: process.env.MINIO_PASSWORD!,
});

describe.skipIf(!endpoint)("S3Store against MinIO", () => {
  beforeAll(async () => {
    const url = new URL(endpoint!);
    const headers = await signRequest({
      method: "PUT",
      host: url.host,
      path: `/${bucket}`,
      query: [],
      headers: {},
      body: "",
      region: "us-east-1",
      accessKeyId: base().accessKeyId,
      secretAccessKey: base().secretAccessKey,
      now: new Date(),
    });
    const res = await fetch(`${endpoint}/${bucket}`, { method: "PUT", headers });
    expect(res.status).toBe(200);
  });

  it("passes the probe", async () => {
    await new S3Store(http, base()).probe();
  });

  it("creates the salt once and keeps it", async () => {
    const s = new S3Store(http, { ...base(), prefix: "salt-test" });
    expect(await s.readSalt()).toBeNull();
    const first = "a".repeat(32);
    expect(await s.createSalt(first)).toBe(first);
    expect(await s.createSalt("b".repeat(32))).toBe(first);
  });

  it("puts, lists, describes and deletes devices; versions change only on write", async () => {
    const s = new S3Store(http, { ...base(), prefix: "team vault/é" });
    await s.putDevice("dev-1", "AAAA", { label: "Laptop", pushedAt: "2026-09-17T10:00:00.000Z" });
    await s.putDevice("dev-2", "BBBB", { label: "Desktop", pushedAt: "2026-09-17T10:01:00.000Z" });
    const before = await s.listDevices();
    expect(before.map((d) => d.id).sort()).toEqual(["dev-1", "dev-2"]);
    await s.putDevice("dev-1", "CCCC", { label: "Laptop", pushedAt: "2026-09-17T10:02:00.000Z" });
    const after = await s.listDevices();
    const v = (list: typeof before, id: string) => list.find((d) => d.id === id)!.version;
    expect(v(after, "dev-1")).not.toBe(v(before, "dev-1"));
    expect(v(after, "dev-2")).toBe(v(before, "dev-2"));
    expect(await s.getDevice("dev-1")).toBe("CCCC");
    expect((await s.describeDevices()).find((d) => d.id === "dev-2")?.label).toBe("Desktop");
    await s.deleteDevice("dev-2");
    await s.deleteDevice("dev-2");
    expect(await s.getDevice("dev-2")).toBeNull();
    expect((await s.listDevices()).map((d) => d.id)).toEqual(["dev-1"]);
    expect((await s.describeDevices()).map((d) => d.id)).toEqual(["dev-1"]);
  });

  it("deletes keys that need XML escaping", async () => {
    const s = new S3Store(http, { ...base(), prefix: "a&b<c>'\"" });
    await s.putDevice("dev-x", "XXXX", { label: "X", pushedAt: "t" });
    await s.deleteDevice("dev-x");
    expect(await s.getDevice("dev-x")).toBeNull();
    expect(await s.listDevices()).toEqual([]);
  });

  it("isolates prefixes", async () => {
    await new S3Store(http, { ...base(), prefix: "p1" }).putDevice("x", "1", { label: "", pushedAt: "t" });
    expect(await new S3Store(http, { ...base(), prefix: "p2" }).listDevices()).toEqual([]);
  });

  it("maps a wrong secret to auth and a missing bucket to not_found", async () => {
    await expect(new S3Store(http, { ...base(), secretAccessKey: "wrong" }).listDevices()).rejects.toMatchObject({ kind: "auth" });
    await expect(new S3Store(http, { ...base(), bucket: "does-not-exist-vs" }).readSalt()).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(new S3Store(http, { ...base(), bucket: "does-not-exist-vs" }).deleteDevice("dev-1")).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});
