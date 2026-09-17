import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVaultSyncEngine, WRONG_PASSPHRASE_MSG } from "./engine";
import { StoreError } from "./store";
import { fakeApi, MemoryStore } from "./testing/fakes";

const values = { storage: { endpoint: "https://x" }, vault: { token: "t" } };

function setup(store = new MemoryStore()) {
  const f = fakeApi();
  const engine = createVaultSyncEngine({
    api: f.api,
    storageKeys: ["endpoint"],
    vaultKeys: ["token"],
    openStore: async () => ((await f.api.vault.get("token")) ? store : null),
  });
  return { ...f, engine, store };
}

async function seedOtherDevice(store: MemoryStore, passphrase: string, id = "other") {
  const key = `key(${passphrase},${store.salt})`;
  await store.putDevice(id, `${key}|${id}|1`, { label: id, pushedAt: "2026-01-01T00:00:00.000Z" });
}

beforeEach(() => {
  vi.stubGlobal("navigator", { onLine: true, userAgent: "Mozilla (TestOS; x)" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createVault", () => {
  it("stores config, creates the salt and pushes this device", async () => {
    const { engine, store, storage, vault } = setup();
    await engine.createVault(store, "pw", values);
    expect(store.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(storage.get("endpoint")).toBe("https://x");
    expect(vault.get("token")).toBe("t");
    expect(vault.get("passphrase")).toBe("pw");
    const own = await engine.getDeviceId();
    expect(store.devices.get(own)?.label).toBe("TestOS");
    expect(engine.getState().configured).toBe(true);
  });

  it("refuses when a vault already exists", async () => {
    const { engine, store } = setup();
    store.salt = "a".repeat(32);
    await expect(engine.createVault(store, "pw", values)).rejects.toThrow(/already exists/);
  });

  it("rolls the config back when the first push fails", async () => {
    const store = new MemoryStore();
    store.putDevice = async () => {
      throw new Error("boom");
    };
    const { engine, storage, vault } = setup(store);
    await expect(engine.createVault(store, "pw", values)).rejects.toThrow("boom");
    expect(storage.has("endpoint")).toBe(false);
    expect(vault.has("token")).toBe(false);
    expect(vault.has("passphrase")).toBe(false);
    expect(engine.getState().configured).toBe(false);
  });
});

describe("linkVault", () => {
  it("imports an existing blob with the right passphrase", async () => {
    const { engine, store, imported } = setup();
    store.salt = "b".repeat(32);
    await seedOtherDevice(store, "pw");
    await engine.linkVault(store, "pw", values);
    expect(imported).toHaveLength(1);
    expect(engine.getState().configured).toBe(true);
  });

  it("rejects a wrong passphrase and restores the previous config", async () => {
    const { engine, store, vault, storage } = setup();
    store.salt = "b".repeat(32);
    await seedOtherDevice(store, "right");
    await expect(engine.linkVault(store, "wrong", values)).rejects.toThrow(WRONG_PASSPHRASE_MSG);
    expect(vault.has("passphrase")).toBe(false);
    expect(storage.has("endpoint")).toBe(false);
  });

  it("fails when no vault exists", async () => {
    const { engine, store } = setup();
    await expect(engine.linkVault(store, "pw", values)).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("syncNow", () => {
  it("imports only other devices whose version changed", async () => {
    const { engine, store, imported } = setup();
    await engine.createVault(store, "pw", values);
    await seedOtherDevice(store, "pw");
    await engine.syncNow();
    expect(imported).toHaveLength(1);
    await engine.syncNow();
    expect(imported).toHaveLength(1);
    await seedOtherDevice(store, "pw");
    await engine.syncNow();
    expect(imported).toHaveLength(2);
    expect(engine.getState().status).toBe("success");
  });

  it("retries a conflict and then succeeds", async () => {
    const { engine, store } = setup();
    await engine.createVault(store, "pw", values);
    store.failNext = [new StoreError("conflict", "etag"), new StoreError("conflict", "etag")];
    await engine.syncNow();
    expect(engine.getState().status).toBe("success");
  });

  it("stops polling on an auth error", async () => {
    vi.useFakeTimers();
    const { engine, store } = setup();
    await engine.createVault(store, "pw", values);
    engine.startPoll(10);
    store.failNext = [new StoreError("auth", "Credentials rejected")];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.getState()).toMatchObject({ status: "error", error: "Credentials rejected" });
    const calls = store.calls;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.calls).toBe(calls);
  });

  it("reports offline when the network is down", async () => {
    const { engine, store } = setup();
    await engine.createVault(store, "pw", values);
    vi.stubGlobal("navigator", { onLine: false, userAgent: "x" });
    store.failNext = [new TypeError("fetch failed")];
    await engine.syncNow();
    expect(engine.getState().status).toBe("offline");
  });
});

describe("disconnect", () => {
  it("forgets every config key", async () => {
    const { engine, store, storage, vault } = setup();
    await engine.createVault(store, "pw", values);
    await engine.disconnect();
    expect(storage.has("endpoint")).toBe(false);
    expect(vault.size).toBe(0);
    expect(engine.getState()).toMatchObject({ configured: false, status: "idle" });
  });
});
