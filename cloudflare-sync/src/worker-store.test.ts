import { describe, expect, it } from "vitest";
import { StoreError } from "../../shared/vault-sync/src/store";
import { fakeHttp } from "../../shared/vault-sync/src/testing/fakes";
import { WorkerStore } from "./worker-store";

const URL_ = "https://w.example";
const manifest = {
  schema: 1,
  salt: "c".repeat(32),
  devices: [{ id: "d1", label: "Laptop", pushedAt: "2026-09-01T00:00:00.000Z" }],
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

describe("WorkerStore", () => {
  it("reads the salt and maps a missing manifest to null", async () => {
    const found = fakeHttp(() => json(200, manifest));
    expect(await new WorkerStore(found.http, URL_, "t").readSalt()).toBe(manifest.salt);
    const missing = fakeHttp(() => json(404, { error: "not_found", message: "nope" }));
    expect(await new WorkerStore(missing.http, URL_, "t").readSalt()).toBeNull();
  });

  it("keeps an existing salt when creating one", async () => {
    const { http, requests } = fakeHttp(() => json(200, manifest));
    expect(await new WorkerStore(http, URL_, "t").createSalt("d".repeat(32))).toBe(manifest.salt);
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("writes a fresh manifest when none exists", async () => {
    const salt = "d".repeat(32);
    const { http, requests } = fakeHttp((req) =>
      req.method === "PUT" ? json(200, JSON.parse(req.body!)) : json(404, { error: "not_found", message: "nope" }),
    );
    expect(await new WorkerStore(http, URL_, "t").createSalt(salt)).toBe(salt);
    const put = requests.find((r) => r.method === "PUT")!;
    expect(JSON.parse(put.body!)).toEqual({ schema: 1, salt, devices: [] });
  });

  it("maps 401 to an auth StoreError", async () => {
    const { http } = fakeHttp(() => json(401, { error: "unauthorized", message: "bad" }));
    const err = await new WorkerStore(http, URL_, "t").listDevices().catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err.kind).toBe("auth");
  });

  it("uses pushedAt as the device version", async () => {
    const { http } = fakeHttp(() => json(200, manifest));
    expect(await new WorkerStore(http, URL_, "t").listDevices()).toEqual([
      { id: "d1", version: "2026-09-01T00:00:00.000Z" },
    ]);
  });

  it("puts a device with the manifest ETag as If-Match and maps 412 to conflict", async () => {
    const { http, requests } = fakeHttp((req) =>
      req.method === "GET" ? json(200, manifest, { ETag: '"m1"' }) : json(412, { error: "precondition_failed", message: "etag" }),
    );
    const err = await new WorkerStore(http, URL_, "t")
      .putDevice("d1", "blob", { label: "L", pushedAt: "p" })
      .catch((e) => e);
    expect(requests[1].headers["if-match"]).toBe('"m1"');
    expect(err.kind).toBe("conflict");
  });

  it("returns null for a missing device blob", async () => {
    const { http } = fakeHttp(() => json(404, { error: "not_found", message: "Device blob not found" }));
    expect(await new WorkerStore(http, URL_, "t").getDevice("zz")).toBeNull();
  });
});
