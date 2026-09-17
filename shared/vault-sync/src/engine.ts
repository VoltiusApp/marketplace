import type { PluginAPI } from "@voltius/plugin-types";
import { generateSaltHex } from "./crypto";
import { StoreError, type VaultStore } from "./store";

export type SyncStatus = "idle" | "syncing" | "success" | "error" | "offline";
export type VaultState = "exists" | "empty";
export type EngineState = {
  status: SyncStatus;
  lastSync: Date | null;
  error: string | null;
  configured: boolean;
  blobSizeBytes: number | null;
};
export type ConfigValues = { storage: Record<string, string>; vault: Record<string, string> };
export type EngineOptions = {
  api: PluginAPI;
  storageKeys: readonly string[];
  vaultKeys: readonly string[];
  openStore(): Promise<VaultStore | null>;
};
export type VaultSyncEngine = ReturnType<typeof createVaultSyncEngine>;

export const MAX_SYNC_CONFLICT_RETRIES = 3;
export const WRONG_PASSPHRASE_MSG = "The passphrase does not match the remote vault — check it and try again";
const PASSPHRASE_KEY = "passphrase";

export function createVaultSyncEngine({ api, storageKeys, vaultKeys, openStore }: EngineOptions) {
  const secretKeys = [...vaultKeys, PASSPHRASE_KEY];
  let status: SyncStatus = "idle";
  let lastSync: Date | null = null;
  let error: string | null = null;
  let blobSizeBytes: number | null = null;
  let configured = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const seenVersions: Record<string, string> = {};
  const listeners = new Set<() => void>();

  const getState = (): EngineState => ({ status, lastSync, error, configured, blobSizeBytes });

  function publish() {
    api.ui.publishState("sync-state", getState());
    for (const cb of listeners) cb();
  }

  function setState(next: SyncStatus, message?: string) {
    status = next;
    error = message ?? null;
    if (next === "success") lastSync = new Date();
    publish();
  }

  function markConfigured(value: boolean) {
    configured = value;
    publish();
  }

  function onStateChange(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  async function readConfig() {
    return Promise.all([
      Promise.all(storageKeys.map((k) => api.storage.get<string>(k))),
      Promise.all(secretKeys.map((k) => api.vault.get(k))),
    ]);
  }

  async function isConfigured(): Promise<boolean> {
    const [stored, secrets] = await readConfig();
    return stored.every((v) => v !== null) && secrets.every(Boolean);
  }

  async function getDeviceId(): Promise<string> {
    let id = await api.storage.get<string>("deviceId");
    if (!id) {
      id = crypto.randomUUID();
      await api.storage.set("deviceId", id);
    }
    return id;
  }

  async function getDeviceLabel(): Promise<string> {
    const stored = await api.storage.get<string>("deviceLabel");
    if (stored) return stored;
    const match = navigator.userAgent.match(/\(([^)]+)\)/);
    return match ? match[1].split(";")[0].trim() : "Unknown device";
  }

  async function requireStore(): Promise<VaultStore> {
    const store = await openStore();
    if (!store) throw new Error("Sync is not configured");
    return store;
  }

  async function requireSalt(store: VaultStore): Promise<string> {
    const salt = await store.readSalt();
    if (!salt) throw new StoreError("not_found", "Vault not found — re-configure in Settings");
    return salt;
  }

  async function encKey(salt: string): Promise<string> {
    const passphrase = await api.vault.get(PASSPHRASE_KEY);
    if (!passphrase) throw new Error("A passphrase is required");
    return api.crypto.deriveKey(passphrase, salt);
  }

  async function writeConfig(values: ConfigValues, passphrase: string): Promise<() => Promise<void>> {
    const [prevStored, prevSecrets] = await readConfig();
    await Promise.all([
      ...storageKeys.map((k) => api.storage.set(k, values.storage[k] ?? "")),
      ...vaultKeys.map((k) => api.vault.set(k, values.vault[k] ?? "")),
      api.vault.set(PASSPHRASE_KEY, passphrase),
    ]);
    return async () => {
      await Promise.all([
        ...storageKeys.map((k, i) => (prevStored[i] === null ? api.storage.delete(k) : api.storage.set(k, prevStored[i]))),
        ...secretKeys.map((k, i) => {
          const prev = prevSecrets[i];
          return prev === null ? api.vault.delete(k) : api.vault.set(k, prev);
        }),
      ]);
      markConfigured(prevStored.every((v) => v !== null) && prevSecrets.every(Boolean));
    };
  }

  async function pushTo(store: VaultStore, salt: string) {
    const [deviceId, label] = await Promise.all([getDeviceId(), getDeviceLabel()]);
    const blob = await api.sync.exportState(await encKey(salt), deviceId);
    await store.putDevice(deviceId, blob, { label, pushedAt: new Date().toISOString() });
    blobSizeBytes = Math.round((blob.length * 3) / 4);
  }

  async function pullFrom(store: VaultStore, salt: string): Promise<boolean> {
    const deviceId = await getDeviceId();
    const changed = (await store.listDevices()).filter((d) => d.id !== deviceId && seenVersions[d.id] !== d.version);
    if (changed.length === 0) return false;
    const blobs: string[] = [];
    for (const d of changed) {
      const blob = await store.getDevice(d.id);
      if (blob) blobs.push(blob);
    }
    if (blobs.length === 0) return false;
    await api.sync.importStates(await encKey(salt), blobs);
    for (const d of changed) seenVersions[d.id] = d.version;
    return true;
  }

  async function detectVault(store: VaultStore): Promise<VaultState> {
    return (await store.readSalt()) ? "exists" : "empty";
  }

  async function createVault(store: VaultStore, passphrase: string, values: ConfigValues) {
    if (!passphrase) throw new Error("A passphrase is required");
    if ((await detectVault(store)) === "exists") {
      throw new Error("A remote vault already exists — link it instead");
    }
    const rollback = await writeConfig(values, passphrase);
    try {
      await pushTo(store, await store.createSalt(generateSaltHex()));
      markConfigured(true);
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  async function linkVault(store: VaultStore, passphrase: string, values: ConfigValues) {
    if (!passphrase) throw new Error("A passphrase is required");
    const salt = await store.readSalt();
    if (!salt) throw new StoreError("not_found", "No vault exists here yet — create one instead");
    const rollback = await writeConfig(values, passphrase);
    try {
      const key = await encKey(salt);
      for (const d of await store.listDevices()) {
        const blob = await store.getDevice(d.id);
        if (!blob) continue;
        try {
          await api.sync.importStates(key, [blob]);
        } catch {
          throw new Error(WRONG_PASSPHRASE_MSG);
        }
        seenVersions[d.id] = d.version;
        break;
      }
      markConfigured(true);
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  function stopPoll() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPoll(intervalSeconds: number) {
    stopPoll();
    pollTimer = setInterval(() => void syncNow(), intervalSeconds * 1000);
  }

  async function disconnect() {
    await Promise.all([
      ...storageKeys.map((k) => api.storage.delete(k)),
      ...secretKeys.map((k) => api.vault.delete(k)),
    ]);
    stopPoll();
    markConfigured(false);
    setState("idle");
  }

  async function removeRemoteDevice(deviceId: string) {
    await (await requireStore()).deleteDevice(deviceId);
    delete seenVersions[deviceId];
  }

  async function listRemoteDevices() {
    return (await requireStore()).describeDevices();
  }

  async function push() {
    if (!(await isConfigured())) return;
    const store = await requireStore();
    await pushTo(store, await requireSalt(store));
  }

  function onSyncError(err: unknown) {
    if (err instanceof StoreError) {
      if (err.kind === "auth" || err.kind === "not_found") {
        stopPoll();
        setState("error", err.message);
        return;
      }
      if (err.kind === "conflict") {
        setState("error", "Remote changed during sync — try again");
        return;
      }
    }
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    setState(offline ? "offline" : "error", offline ? undefined : err instanceof Error ? err.message : String(err));
  }

  async function syncNow(): Promise<void> {
    if (!(await isConfigured()) || status === "syncing") return;
    setState("syncing");
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const store = await requireStore();
          const salt = await requireSalt(store);
          await pullFrom(store, salt);
          await pushTo(store, salt);
          break;
        } catch (err) {
          const conflict = err instanceof StoreError && err.kind === "conflict";
          if (!conflict || attempt === MAX_SYNC_CONFLICT_RETRIES) throw err;
        }
      }
      await api.storage.set("lastSync", new Date().toISOString());
      setState("success");
    } catch (err) {
      if (!(await isConfigured())) {
        setState("idle");
        return;
      }
      onSyncError(err);
    }
  }

  function activate(): () => void {
    publish();
    void isConfigured().then(markConfigured).catch(() => {});
    api.plugins.expose({ syncNow });
    let offBeforeQuit: (() => void) | null = null;
    if (api.isActive()) {
      void (async () => {
        if (!(await isConfigured())) return;
        await syncNow();
        startPoll((await api.storage.get<number>("pollIntervalSeconds")) ?? 60);
      })();
      offBeforeQuit = api.lifecycle.onBeforeQuit(async () => {
        await push().catch(() => {});
      });
    }
    return () => {
      stopPoll();
      offBeforeQuit?.();
    };
  }

  return {
    getState,
    onStateChange,
    isConfigured,
    getDeviceId,
    detectVault,
    createVault,
    linkVault,
    disconnect,
    removeRemoteDevice,
    listRemoteDevices,
    push,
    syncNow,
    startPoll,
    stopPoll,
    activate,
  };
}
