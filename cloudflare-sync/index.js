// ../shared/vault-sync/src/crypto.ts
function generateSaltHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ../shared/vault-sync/src/store.ts
var StoreError = class extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.name = "StoreError";
  }
};

// ../shared/vault-sync/src/engine.ts
var MAX_SYNC_CONFLICT_RETRIES = 3;
var WRONG_PASSPHRASE_MSG = "The passphrase does not match the remote vault \u2014 check it and try again";
var PASSPHRASE_KEY = "passphrase";
var PASSPHRASE_REQUIRED_MSG = "A passphrase is required";
function isComplete(stored, secrets) {
  return stored.every((v) => v !== null) && secrets.every(Boolean);
}
function createVaultSyncEngine({ api, storageKeys, vaultKeys, openStore }) {
  const secretKeys = [...vaultKeys, PASSPHRASE_KEY];
  let status = "idle";
  let lastSync = null;
  let error = null;
  let blobSizeBytes = null;
  let configured = false;
  let pollTimer = null;
  const seenVersions = {};
  const listeners = /* @__PURE__ */ new Set();
  const getState = () => ({ status, lastSync, error, configured, blobSizeBytes });
  function publish() {
    api.ui.publishState("sync-state", getState());
    for (const cb of listeners) cb();
  }
  function setState(next, message) {
    status = next;
    error = message ?? null;
    if (next === "success") lastSync = /* @__PURE__ */ new Date();
    publish();
  }
  function markConfigured(value) {
    configured = value;
    publish();
  }
  function onStateChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }
  async function readConfig() {
    return Promise.all([
      Promise.all(storageKeys.map((k) => api.storage.get(k))),
      Promise.all(secretKeys.map((k) => api.vault.get(k)))
    ]);
  }
  async function isConfigured() {
    const [stored, secrets] = await readConfig();
    return isComplete(stored, secrets);
  }
  async function getDeviceId() {
    let id = await api.storage.get("deviceId");
    if (!id) {
      id = crypto.randomUUID();
      await api.storage.set("deviceId", id);
    }
    return id;
  }
  async function getDeviceLabel() {
    const stored = await api.storage.get("deviceLabel");
    if (stored) return stored;
    const match = navigator.userAgent.match(/\(([^)]+)\)/);
    return match ? match[1].split(";")[0].trim() : "Unknown device";
  }
  async function requireStore() {
    const store = await openStore();
    if (!store) throw new Error("Sync is not configured");
    return store;
  }
  async function requireSalt(store) {
    const salt = await store.readSalt();
    if (!salt) throw new StoreError("not_found", "Vault not found \u2014 re-configure in Settings");
    return salt;
  }
  async function encKey(salt) {
    const passphrase = await api.vault.get(PASSPHRASE_KEY);
    if (!passphrase) throw new Error(PASSPHRASE_REQUIRED_MSG);
    return api.crypto.deriveKey(passphrase, salt);
  }
  async function writeConfig(values, passphrase) {
    const [prevStored, prevSecrets] = await readConfig();
    await Promise.all([
      ...storageKeys.map((k) => api.storage.set(k, values.storage[k] ?? "")),
      ...vaultKeys.map((k) => api.vault.set(k, values.vault[k] ?? "")),
      api.vault.set(PASSPHRASE_KEY, passphrase)
    ]);
    return async () => {
      await Promise.all([
        ...storageKeys.map((k, i) => prevStored[i] === null ? api.storage.delete(k) : api.storage.set(k, prevStored[i])),
        ...secretKeys.map((k, i) => {
          const prev = prevSecrets[i];
          return prev === null ? api.vault.delete(k) : api.vault.set(k, prev);
        })
      ]);
      markConfigured(isComplete(prevStored, prevSecrets));
    };
  }
  async function withConfig(values, passphrase, fn) {
    const rollback = await writeConfig(values, passphrase);
    try {
      await fn();
      markConfigured(true);
    } catch (err) {
      await rollback().catch(() => {
      });
      throw err;
    }
  }
  async function pushTo(store, salt) {
    const [deviceId, label] = await Promise.all([getDeviceId(), getDeviceLabel()]);
    const blob = await api.sync.exportState(await encKey(salt), deviceId);
    await store.putDevice(deviceId, blob, { label, pushedAt: (/* @__PURE__ */ new Date()).toISOString() });
    blobSizeBytes = Math.round(blob.length * 3 / 4);
  }
  async function pullFrom(store, salt) {
    const deviceId = await getDeviceId();
    const changed = (await store.listDevices()).filter((d) => d.id !== deviceId && seenVersions[d.id] !== d.version);
    if (changed.length === 0) return false;
    const blobs = [];
    for (const d of changed) {
      const blob = await store.getDevice(d.id);
      if (blob) blobs.push(blob);
    }
    if (blobs.length === 0) return false;
    await api.sync.importStates(await encKey(salt), blobs);
    for (const d of changed) seenVersions[d.id] = d.version;
    return true;
  }
  async function detectVault(store) {
    const salt = await store.readSalt();
    if (!salt) return "empty";
    return (await store.listDevices()).length > 0 ? "exists" : "empty";
  }
  async function createVault(store, passphrase, values) {
    if (!passphrase) throw new Error(PASSPHRASE_REQUIRED_MSG);
    if (await detectVault(store) === "exists") {
      throw new Error("A remote vault already exists \u2014 link it instead");
    }
    await withConfig(values, passphrase, async () => pushTo(store, await store.createSalt(generateSaltHex())));
  }
  async function linkVault(store, passphrase, values) {
    if (!passphrase) throw new Error(PASSPHRASE_REQUIRED_MSG);
    const salt = await store.readSalt();
    if (!salt) throw new StoreError("not_found", "No vault exists here yet \u2014 create one instead");
    await withConfig(values, passphrase, async () => {
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
    });
  }
  function stopPoll() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  function startPoll(intervalSeconds) {
    stopPoll();
    pollTimer = setInterval(() => void syncNow(), intervalSeconds * 1e3);
  }
  async function disconnect() {
    await Promise.all([
      ...storageKeys.map((k) => api.storage.delete(k)),
      ...secretKeys.map((k) => api.vault.delete(k))
    ]);
    stopPoll();
    markConfigured(false);
    setState("idle");
  }
  async function removeRemoteDevice(deviceId) {
    await (await requireStore()).deleteDevice(deviceId);
    delete seenVersions[deviceId];
  }
  async function listRemoteDevices() {
    return (await requireStore()).describeDevices();
  }
  async function push() {
    if (!await isConfigured()) return;
    const store = await requireStore();
    await pushTo(store, await requireSalt(store));
  }
  function onSyncError(err) {
    if (err instanceof StoreError) {
      if (err.kind === "auth" || err.kind === "not_found") {
        stopPoll();
        setState("error", err.message);
        return;
      }
      if (err.kind === "conflict") {
        setState("error", "Remote changed during sync \u2014 try again");
        return;
      }
    }
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    setState(offline ? "offline" : "error", offline ? void 0 : err instanceof Error ? err.message : String(err));
  }
  let inFlight = null;
  function syncNow() {
    return inFlight ??= runSync().finally(() => {
      inFlight = null;
    });
  }
  async function runSync() {
    if (!await isConfigured()) return;
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
      await api.storage.set("lastSync", (/* @__PURE__ */ new Date()).toISOString());
      setState("success");
    } catch (err) {
      if (!await isConfigured()) {
        setState("idle");
        return;
      }
      onSyncError(err);
    }
  }
  function activate() {
    publish();
    void isConfigured().then(markConfigured).catch(() => {
    });
    api.plugins.expose({ syncNow });
    let offBeforeQuit = null;
    if (api.isActive()) {
      void (async () => {
        if (!await isConfigured()) return;
        await syncNow();
        startPoll(await api.storage.get("pollIntervalSeconds") ?? 60);
      })();
      offBeforeQuit = api.lifecycle.onBeforeQuit(async () => {
        await push().catch(() => {
        });
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
    activate
  };
}

// ../shared/vault-sync/src/http.ts
var REQUEST_TIMEOUT_MS = 6e4;
function parseJson(body) {
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    return null;
  }
}
async function send(http, url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${timeoutMs / 1e3}s: ${url}`));
    }, timeoutMs);
  });
  const request = (async () => {
    const res = await http.stream(url, { ...init, signal: controller.signal });
    return { status: res.status, ok: res.ok, headers: res.headers, body: await res.text() };
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// src/worker-api.ts
var WorkerApiError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "WorkerApiError";
  }
};
function isConflictStatus(status) {
  return status === 412 || status === 409;
}
function normalizeBaseUrl(workerUrl) {
  return workerUrl.replace(/\/+$/, "");
}
function headers(token, ifMatch) {
  const h = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (ifMatch) h["If-Match"] = ifMatch;
  return h;
}
function checkResponse(res, context) {
  if (!res.ok) {
    const parsed = parseJson(res.body);
    const message = parsed?.message ?? parsed?.error ?? res.body;
    throw new WorkerApiError(res.status, `${context}: ${message}`);
  }
}
async function call(http, workerUrl, path, context, init = {}) {
  const res = await send(http, `${normalizeBaseUrl(workerUrl)}${path}`, init);
  checkResponse(res, context);
  const data = parseJson(res.body);
  if (data === null) throw new WorkerApiError(res.status, `${context}: response is not JSON`);
  return { data, res };
}
async function getHealth(http, workerUrl) {
  return (await call(http, workerUrl, "/health", "getHealth")).data;
}
async function getManifestWithEtag(http, workerUrl, token) {
  const { data, res } = await call(http, workerUrl, "/v1/manifest", "getManifest", {
    headers: headers(token)
  });
  return { manifest: data, etag: res.headers.get("ETag") };
}
async function getManifest(http, workerUrl, token) {
  return (await getManifestWithEtag(http, workerUrl, token)).manifest;
}
async function putManifest(http, workerUrl, token, manifest, opts = {}) {
  const { data } = await call(http, workerUrl, "/v1/manifest", "putManifest", {
    method: "PUT",
    headers: headers(token, opts.ifMatch),
    body: JSON.stringify(manifest)
  });
  return data;
}
function devicePath(deviceId) {
  return `/v1/devices/${encodeURIComponent(deviceId)}`;
}
async function getDeviceBlob(http, workerUrl, token, deviceId) {
  const { data } = await call(
    http,
    workerUrl,
    devicePath(deviceId),
    `getDeviceBlob(${deviceId})`,
    { headers: headers(token) }
  );
  return data.content;
}
async function putDeviceBlob(http, workerUrl, token, deviceId, body, opts = {}) {
  await call(http, workerUrl, devicePath(deviceId), `putDeviceBlob(${deviceId})`, {
    method: "PUT",
    headers: headers(token, opts.ifMatch),
    body: JSON.stringify(body)
  });
}
async function deleteDevice(http, workerUrl, token, deviceId) {
  await call(http, workerUrl, devicePath(deviceId), `deleteDevice(${deviceId})`, {
    method: "DELETE",
    headers: headers(token)
  });
}
function normalizeWorkerUrl(raw) {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("cloudflare-sync: Worker URL is required");
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("cloudflare-sync: Worker URL is invalid");
  }
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("cloudflare-sync: Worker URL must use https:// (http:// only for localhost)");
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

// src/worker-store.ts
function toStoreError(err) {
  if (!(err instanceof WorkerApiError)) return err;
  if (err.status === 401) {
    return new StoreError(
      "auth",
      "The Worker rejected the sync token. It must match the SYNC_TOKEN secret set on the Worker.",
      401
    );
  }
  if (err.status === 404) return new StoreError("not_found", "Vault not found \u2014 re-configure in Settings", 404);
  if (isConflictStatus(err.status)) return new StoreError("conflict", err.message, err.status);
  return err;
}
var WorkerStore = class {
  constructor(http, workerUrl, token) {
    this.http = http;
    this.workerUrl = workerUrl;
    this.token = token;
  }
  async guard(fn) {
    try {
      return await fn();
    } catch (err) {
      throw toStoreError(err);
    }
  }
  async nullOn404(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 404) return null;
      throw toStoreError(err);
    }
  }
  manifest() {
    return this.guard(() => getManifest(this.http, this.workerUrl, this.token));
  }
  async readSalt() {
    return this.nullOn404(async () => (await getManifest(this.http, this.workerUrl, this.token)).salt);
  }
  async createSalt(salt) {
    const existing = await this.readSalt();
    if (existing) return existing;
    return this.guard(async () => {
      const written = await putManifest(this.http, this.workerUrl, this.token, { schema: 1, salt, devices: [] });
      return written.salt;
    });
  }
  async listDevices() {
    return (await this.manifest()).devices.map((d) => ({ id: d.id, version: d.pushedAt }));
  }
  async describeDevices() {
    return (await this.manifest()).devices.map(({ id, label, pushedAt }) => ({ id, label, pushedAt }));
  }
  async getDevice(id) {
    return this.nullOn404(() => getDeviceBlob(this.http, this.workerUrl, this.token, id));
  }
  async putDevice(id, blob, info) {
    await this.guard(async () => {
      const { etag } = await getManifestWithEtag(this.http, this.workerUrl, this.token);
      await putDeviceBlob(this.http, this.workerUrl, this.token, id, { content: blob, ...info }, { ifMatch: etag });
    });
  }
  async deleteDevice(id) {
    await this.guard(() => deleteDevice(this.http, this.workerUrl, this.token, id));
  }
};

// src/engine.ts
function createCloudflareEngine(api) {
  return createVaultSyncEngine({
    api,
    storageKeys: ["workerUrl"],
    vaultKeys: ["syncToken"],
    openStore: async () => {
      const [url, token] = await Promise.all([api.storage.get("workerUrl"), api.vault.get("syncToken")]);
      return url && token ? new WorkerStore(api.http, url, token) : null;
    }
  });
}

// src/i18n.ts
var messages = {
  en: { settingsLabel: "Cloudflare Sync" },
  fr: { settingsLabel: "Synchronisation Cloudflare" },
  ru: { settingsLabel: "\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u044F Cloudflare" },
  zh: { settingsLabel: "Cloudflare \u540C\u6B65" }
};

// src/SettingsPage.tsx
import { useEffect as useEffect3, useState as useState5 } from "react";

// ../shared/vault-sync/src/ui/components.tsx
import { useState } from "react";
import { Icon } from "@voltius/ui";

// ../node_modules/@tauri-apps/api/external/tslib/tslib.es6.js
function __classPrivateFieldGet(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}
function __classPrivateFieldSet(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}

// ../node_modules/@tauri-apps/api/core.js
var _Channel_onmessage;
var _Channel_nextMessageIndex;
var _Channel_pendingMessages;
var _Channel_messageEndIndex;
var _Resource_rid;
var SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";
function transformCallback(callback, once = false) {
  return window.__TAURI_INTERNALS__.transformCallback(callback, once);
}
var Channel = class {
  constructor(onmessage) {
    _Channel_onmessage.set(this, void 0);
    _Channel_nextMessageIndex.set(this, 0);
    _Channel_pendingMessages.set(this, []);
    _Channel_messageEndIndex.set(this, void 0);
    __classPrivateFieldSet(this, _Channel_onmessage, onmessage || (() => {
    }), "f");
    this.id = transformCallback((rawMessage) => {
      const index = rawMessage.index;
      if ("end" in rawMessage) {
        if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) {
          this.cleanupCallback();
        } else {
          __classPrivateFieldSet(this, _Channel_messageEndIndex, index, "f");
        }
        return;
      }
      const message = rawMessage.message;
      if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) {
        __classPrivateFieldGet(this, _Channel_onmessage, "f").call(this, message);
        __classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
        while (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") in __classPrivateFieldGet(this, _Channel_pendingMessages, "f")) {
          const message2 = __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
          __classPrivateFieldGet(this, _Channel_onmessage, "f").call(this, message2);
          delete __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
          __classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
        }
        if (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") === __classPrivateFieldGet(this, _Channel_messageEndIndex, "f")) {
          this.cleanupCallback();
        }
      } else {
        __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[index] = message;
      }
    });
  }
  cleanupCallback() {
    window.__TAURI_INTERNALS__.unregisterCallback(this.id);
  }
  set onmessage(handler) {
    __classPrivateFieldSet(this, _Channel_onmessage, handler, "f");
  }
  get onmessage() {
    return __classPrivateFieldGet(this, _Channel_onmessage, "f");
  }
  [(_Channel_onmessage = /* @__PURE__ */ new WeakMap(), _Channel_nextMessageIndex = /* @__PURE__ */ new WeakMap(), _Channel_pendingMessages = /* @__PURE__ */ new WeakMap(), _Channel_messageEndIndex = /* @__PURE__ */ new WeakMap(), SERIALIZE_TO_IPC_FN)]() {
    return `__CHANNEL__:${this.id}`;
  }
  toJSON() {
    return this[SERIALIZE_TO_IPC_FN]();
  }
};
async function invoke(cmd, args = {}, options) {
  return window.__TAURI_INTERNALS__.invoke(cmd, args, options);
}
_Resource_rid = /* @__PURE__ */ new WeakMap();

// ../node_modules/@tauri-apps/plugin-opener/dist-js/index.js
async function openUrl(url, openWith) {
  await invoke("plugin:opener|open_url", {
    url,
    with: openWith
  });
}

// ../node_modules/@tauri-apps/plugin-clipboard-manager/dist-js/index.js
async function writeText(text, opts) {
  await invoke("plugin:clipboard-manager|write_text", {
    label: opts?.label,
    text
  });
}

// ../shared/vault-sync/src/describeError.ts
function describeError(err) {
  const message = (err instanceof Error ? err.message : String(err)).replace(/^[a-z0-9-]+:\s*/, "");
  return message.charAt(0).toUpperCase() + message.slice(1);
}

// ../shared/vault-sync/src/ui/components.tsx
import { jsx, jsxs } from "react/jsx-runtime";
function openExternal(url) {
  void openUrl(url).catch(() => {
  });
}
async function copyText(text) {
  try {
    await writeText(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}
function Btn({
  children,
  onClick,
  disabled,
  variant = "primary",
  small,
  busy,
  title
}) {
  const base = "inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default";
  const size = small ? "px-3 py-1 text-xs" : "px-4 py-2 text-sm";
  const colors = variant === "primary" ? "bg-(--t-accent) text-white hover:bg-(--t-accent-hover)" : variant === "danger" ? "bg-transparent border border-(--t-status-error) text-(--t-status-error) hover:bg-[color-mix(in_srgb,var(--t-status-error)_10%,transparent)]" : "bg-(--t-bg-elevated) border border-(--t-border) text-(--t-text-muted) hover:border-(--t-border-hover)";
  return /* @__PURE__ */ jsxs("button", { className: `${base} ${size} ${colors}`, onClick, disabled: disabled || busy, title, children: [
    busy && /* @__PURE__ */ jsx(Icon, { icon: "lucide:loader-circle", width: 13, className: "animate-spin" }),
    children
  ] });
}
function LinkButton({ children, onClick }) {
  return /* @__PURE__ */ jsx("button", { type: "button", onClick, className: "text-(--t-accent) hover:underline", children });
}
function Card({ title, aside, children }) {
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-3 p-4 rounded-xl bg-(--t-bg-elevated) border border-(--t-border)", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between gap-2", children: [
      /* @__PURE__ */ jsx("p", { className: "text-xs font-semibold text-(--t-text-muted) uppercase tracking-wide", children: title }),
      aside
    ] }),
    children
  ] });
}
var INPUT_CLASS = "form-input w-full px-3 py-2 rounded-lg text-sm outline-hidden bg-(--t-bg-input) border border-(--t-border) text-(--t-text-primary)";
function FieldShell({ label, hint, children }) {
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1", children: [
    /* @__PURE__ */ jsx("label", { className: "text-xs font-medium text-(--t-text-muted)", children: label }),
    children,
    hint && /* @__PURE__ */ jsx("p", { className: "text-xs text-(--t-text-dim)", children: hint })
  ] });
}
function TextInput({
  label,
  hint,
  value,
  onChange,
  placeholder
}) {
  return /* @__PURE__ */ jsx(FieldShell, { label, hint, children: /* @__PURE__ */ jsx(
    "input",
    {
      className: INPUT_CLASS,
      value,
      onChange: (e) => onChange(e.target.value),
      placeholder,
      autoComplete: "off",
      spellCheck: false
    }
  ) });
}
function SecretInput({
  label,
  hint,
  value,
  onChange,
  placeholder
}) {
  const [show, setShow] = useState(false);
  return /* @__PURE__ */ jsx(FieldShell, { label, hint, children: /* @__PURE__ */ jsxs("div", { className: "relative flex items-center", children: [
    /* @__PURE__ */ jsx(
      "input",
      {
        type: show ? "text" : "password",
        className: `${INPUT_CLASS} pr-9`,
        value,
        onChange: (e) => onChange(e.target.value),
        placeholder,
        autoComplete: "off",
        spellCheck: false
      }
    ),
    /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        className: "absolute right-2 text-(--t-text-dim) hover:text-(--t-text-muted)",
        onClick: () => setShow((s) => !s),
        tabIndex: -1,
        title: show ? "Hide" : "Show",
        children: /* @__PURE__ */ jsx(Icon, { icon: show ? "lucide:eye-off" : "lucide:eye", width: 14 })
      }
    )
  ] }) });
}
function Dot({ tone }) {
  const color = tone === "connected" ? "var(--t-status-connected)" : tone === "error" ? "var(--t-status-error)" : "var(--t-text-dim)";
  return /* @__PURE__ */ jsx("span", { className: "inline-block w-2 h-2 rounded-full shrink-0", style: { background: color } });
}
function ErrorBanner({ message }) {
  return /* @__PURE__ */ jsx("div", { className: "px-3 py-2 rounded-lg text-sm text-(--t-status-error) border border-(--t-status-error) bg-[color-mix(in_srgb,var(--t-status-error)_8%,transparent)]", children: message });
}
function useAction() {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  async function run(key, action) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  }
  return { busy, setBusy, error, setError, run };
}
function Hint({ children }) {
  return /* @__PURE__ */ jsx("p", { className: "text-xs text-(--t-text-dim)", children });
}

// ../shared/vault-sync/src/ui/settings.tsx
import { useCallback, useEffect, useRef, useState as useState2 } from "react";
import { Icon as Icon2 } from "@voltius/ui";
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function useEngineState(engine) {
  const [state, setState] = useState2(engine.getState);
  useEffect(() => engine.onStateChange(() => setState(engine.getState())), [engine]);
  return state;
}
function ConfiguredView({
  api,
  engine,
  connection,
  disconnectHint
}) {
  const sync = useEngineState(engine);
  const [devices, setDevices] = useState2(null);
  const [localDeviceId, setLocalDeviceId] = useState2(null);
  const [pollSeconds, setPollSeconds] = useState2(60);
  const { busy, error, run } = useAction();
  const [confirmDisconnect, setConfirmDisconnect] = useState2(false);
  const deviceRequest = useRef(0);
  const loadDevices = useCallback(async () => {
    const request = ++deviceRequest.current;
    const next = await engine.listRemoteDevices().catch(() => null);
    if (request === deviceRequest.current) setDevices(next);
  }, [engine]);
  useEffect(() => {
    void loadDevices();
    void engine.getDeviceId().then(setLocalDeviceId);
    void api.storage.get("pollIntervalSeconds").then((v) => v && setPollSeconds(v));
  }, [api, engine, loadDevices]);
  useEffect(() => {
    if (sync.status === "success") void loadDevices();
  }, [sync.lastSync, sync.status, loadDevices]);
  return /* @__PURE__ */ jsxs2(Fragment, { children: [
    (error || sync.error) && /* @__PURE__ */ jsx2(ErrorBanner, { message: error ?? sync.error }),
    /* @__PURE__ */ jsxs2(Card, { title: "Sync", children: [
      /* @__PURE__ */ jsxs2("div", { className: "flex items-center justify-between gap-4", children: [
        /* @__PURE__ */ jsxs2("div", { className: "flex flex-col gap-0.5 min-w-0", children: [
          /* @__PURE__ */ jsxs2("span", { className: "flex items-center gap-2 text-sm text-(--t-text-primary)", children: [
            /* @__PURE__ */ jsx2(Dot, { tone: sync.status === "error" ? "error" : sync.status === "success" ? "connected" : "idle" }),
            sync.status === "syncing" ? "Syncing\u2026" : sync.status === "error" ? "Last sync failed" : sync.status === "offline" ? "Offline" : "Up to date"
          ] }),
          /* @__PURE__ */ jsx2("span", { className: "text-xs text-(--t-text-dim)", children: sync.lastSync ? `Last synced ${sync.lastSync.toLocaleString()}` : "Not synced yet in this session" })
        ] }),
        /* @__PURE__ */ jsx2(Btn, { onClick: () => void run("sync", () => engine.syncNow()), busy: busy === "sync" || sync.status === "syncing", children: "Sync now" })
      ] }),
      /* @__PURE__ */ jsxs2("div", { className: "flex items-center justify-between gap-4 pt-3 border-t border-(--t-border)", children: [
        /* @__PURE__ */ jsx2("span", { className: "text-sm text-(--t-text-muted)", children: "Check for changes every" }),
        /* @__PURE__ */ jsxs2("div", { className: "flex items-center gap-2", children: [
          /* @__PURE__ */ jsx2(
            "input",
            {
              type: "number",
              min: 10,
              max: 3600,
              className: "form-input w-20 px-2 py-1 rounded-lg text-sm outline-hidden bg-(--t-bg-input) border border-(--t-border) text-(--t-text-primary)",
              value: pollSeconds,
              onChange: (e) => setPollSeconds(Number(e.target.value) || 60),
              onBlur: () => {
                const clamped = Math.min(3600, Math.max(10, pollSeconds || 60));
                setPollSeconds(clamped);
                void api.storage.set("pollIntervalSeconds", clamped).then(() => {
                  engine.stopPoll();
                  engine.startPoll(clamped);
                });
              }
            }
          ),
          /* @__PURE__ */ jsx2("span", { className: "text-sm text-(--t-text-dim)", children: "seconds" })
        ] })
      ] })
    ] }),
    connection,
    /* @__PURE__ */ jsx2(Card, { title: devices ? `Devices (${devices.length})` : "Devices", children: devices === null ? /* @__PURE__ */ jsx2(Hint, { children: "Could not load the device list." }) : /* @__PURE__ */ jsx2("div", { className: "flex flex-col gap-1.5", children: devices.map((d) => /* @__PURE__ */ jsxs2(
      "div",
      {
        className: "flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-(--t-border) bg-(--t-bg-base)",
        children: [
          /* @__PURE__ */ jsxs2("div", { className: "flex items-center gap-2 min-w-0", children: [
            /* @__PURE__ */ jsx2(Icon2, { icon: "lucide:monitor", width: 14, className: "text-(--t-text-dim) shrink-0" }),
            /* @__PURE__ */ jsxs2("div", { className: "min-w-0", children: [
              /* @__PURE__ */ jsxs2("p", { className: "text-sm text-(--t-text-primary) truncate", children: [
                d.label || d.id,
                d.id === localDeviceId && /* @__PURE__ */ jsx2("span", { className: "text-(--t-text-dim)", children: " \xB7 this device" })
              ] }),
              /* @__PURE__ */ jsx2("p", { className: "text-xs text-(--t-text-dim) truncate", children: d.pushedAt ? `Last pushed ${new Date(d.pushedAt).toLocaleString()}` : "Last push time unknown" })
            ] })
          ] }),
          d.id !== localDeviceId && /* @__PURE__ */ jsx2(
            Btn,
            {
              small: true,
              variant: "secondary",
              busy: busy === `remove:${d.id}`,
              disabled: !!busy,
              onClick: () => void run(`remove:${d.id}`, async () => {
                await engine.removeRemoteDevice(d.id);
                await loadDevices();
              }),
              children: "Remove"
            }
          )
        ]
      },
      d.id
    )) }) }),
    /* @__PURE__ */ jsxs2(Card, { title: "Disconnect", children: [
      /* @__PURE__ */ jsx2(Hint, { children: disconnectHint }),
      /* @__PURE__ */ jsx2("div", { className: "flex items-center gap-2", children: confirmDisconnect ? /* @__PURE__ */ jsxs2(Fragment, { children: [
        /* @__PURE__ */ jsx2(Btn, { variant: "danger", busy: busy === "disconnect", onClick: () => void run("disconnect", engine.disconnect), children: "Yes, disconnect" }),
        /* @__PURE__ */ jsx2(Btn, { variant: "secondary", onClick: () => setConfirmDisconnect(false), children: "Cancel" })
      ] }) : /* @__PURE__ */ jsx2(Btn, { variant: "danger", onClick: () => setConfirmDisconnect(true), children: "Disconnect this device" }) })
    ] })
  ] });
}
function SettingsShell({
  api,
  engine,
  icon,
  intro,
  wizard,
  connection,
  disconnectHint
}) {
  const sync = useEngineState(engine);
  const [configured, setConfigured] = useState2(null);
  useEffect(() => {
    void engine.isConfigured().then(setConfigured);
  }, [engine, sync.configured]);
  return /* @__PURE__ */ jsxs2("div", { className: "flex flex-col gap-6 max-w-lg", children: [
    /* @__PURE__ */ jsxs2("div", { className: "flex items-center gap-2", children: [
      /* @__PURE__ */ jsx2(Icon2, { icon, width: 20, className: "text-(--t-text-primary)" }),
      /* @__PURE__ */ jsx2("h2", { className: "text-base font-semibold text-(--t-text-primary)", children: api.i18n.t("settingsLabel") }),
      configured && /* @__PURE__ */ jsx2(Dot, { tone: sync.status === "error" ? "error" : "connected" })
    ] }),
    /* @__PURE__ */ jsx2("p", { className: "text-sm text-(--t-text-dim) -mt-4", children: intro }),
    configured === false && wizard(() => setConfigured(true)),
    configured && /* @__PURE__ */ jsx2(ConfiguredView, { api, engine, connection, disconnectHint })
  ] });
}

// src/copyToken.ts
async function copyToken(api, token) {
  if (!token) throw new Error("No sync token is stored on this device.");
  await copyText(token);
  api.notifications.toast("Sync token copied", { severity: "success" });
}

// src/SetupWizard.tsx
import { useEffect as useEffect2, useState as useState4 } from "react";
import { Icon as Icon4 } from "@voltius/ui";

// dist/worker.mjs
var worker_default = '// worker/src/auth.ts\nasync function sha256Bytes(value) {\n  const digest = await crypto.subtle.digest(\n    "SHA-256",\n    new TextEncoder().encode(value)\n  );\n  return new Uint8Array(digest);\n}\nfunction timingSafeEqualBytes(a, b) {\n  if (a.length !== b.length) return false;\n  let mismatch = 0;\n  for (let i = 0; i < a.length; i++) {\n    mismatch |= a[i] ^ b[i];\n  }\n  return mismatch === 0;\n}\nfunction extractBearerToken(request) {\n  const header = request.headers.get("authorization");\n  if (!header) return null;\n  const match = /^Bearer\\s+(.+)$/i.exec(header.trim());\n  if (!match) return null;\n  const token = match[1].trim();\n  return token.length > 0 ? token : null;\n}\nasync function requireSyncToken(request, env) {\n  const expected = env.SYNC_TOKEN;\n  if (!expected) {\n    return jsonError(\n      500,\n      "misconfigured",\n      "SYNC_TOKEN secret is not configured on this Worker"\n    );\n  }\n  const provided = extractBearerToken(request);\n  if (!provided) {\n    return jsonError(401, "unauthorized", "Invalid or missing bearer token");\n  }\n  const [got, want] = await Promise.all([sha256Bytes(provided), sha256Bytes(expected)]);\n  if (!timingSafeEqualBytes(got, want)) {\n    return jsonError(401, "unauthorized", "Invalid or missing bearer token");\n  }\n  return null;\n}\nfunction jsonError(status, error, message) {\n  return new Response(JSON.stringify({ error, message }), {\n    status,\n    headers: {\n      "content-type": "application/json; charset=utf-8",\n      "cache-control": "no-store",\n      ...status === 401 ? { "www-authenticate": \'Bearer realm="voltius-cloudflare-sync"\' } : {}\n    }\n  });\n}\n\n// worker/src/cors.ts\nvar CORS_HEADERS = {\n  "access-control-allow-origin": "*",\n  "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS",\n  "access-control-allow-headers": "authorization, content-type, if-match",\n  "access-control-expose-headers": "etag",\n  "access-control-max-age": "86400"\n};\nfunction withCors(response) {\n  const headers = new Headers(response.headers);\n  for (const [k, v] of Object.entries(CORS_HEADERS)) {\n    headers.set(k, v);\n  }\n  return new Response(response.body, {\n    status: response.status,\n    statusText: response.statusText,\n    headers\n  });\n}\nfunction handleOptions() {\n  return new Response(null, { status: 204, headers: CORS_HEADERS });\n}\n\n// worker/src/manifest.ts\nvar MANIFEST_KEY = "manifest.json";\nvar ManifestConflictError = class extends Error {\n  constructor(message = "manifest etag mismatch") {\n    super(message);\n    this.name = "ManifestConflictError";\n  }\n};\nvar SALT_RE = /^[0-9a-f]{32}$/i;\nfunction isManifest(value) {\n  if (!value || typeof value !== "object") return false;\n  const v = value;\n  if (v.schema !== 1) return false;\n  if (typeof v.salt !== "string" || !SALT_RE.test(v.salt)) return false;\n  if (!Array.isArray(v.devices)) return false;\n  for (const d of v.devices) {\n    if (!d || typeof d !== "object") return false;\n    const device = d;\n    if (typeof device.id !== "string" || device.id.length === 0) return false;\n    if (typeof device.label !== "string") return false;\n    if (typeof device.pushedAt !== "string" || device.pushedAt.length === 0) return false;\n  }\n  return true;\n}\nfunction normalizeEtag(etag) {\n  return etag.trim().replace(/^W\\//, "").replace(/^"|"$/g, "");\n}\nfunction etagsMatch(a, b) {\n  return normalizeEtag(a) === normalizeEtag(b);\n}\nfunction objectEtag(obj) {\n  return obj.httpEtag || obj.etag;\n}\nasync function readManifestRecord(bucket) {\n  const obj = await bucket.get(MANIFEST_KEY);\n  if (!obj) return null;\n  const text = await obj.text();\n  let parsed;\n  try {\n    parsed = JSON.parse(text);\n  } catch {\n    throw new Error("manifest.json is not valid JSON");\n  }\n  if (!isManifest(parsed)) {\n    throw new Error("manifest.json failed schema validation");\n  }\n  return { manifest: parsed, etag: objectEtag(obj) };\n}\nasync function writeManifest(bucket, manifest, opts = {}) {\n  if (!isManifest(manifest)) {\n    throw new Error("refusing to write invalid manifest");\n  }\n  const putOpts = {\n    httpMetadata: { contentType: "application/json; charset=utf-8" }\n  };\n  if (opts.ifMatch) {\n    putOpts.onlyIf = { etagMatches: normalizeEtag(opts.ifMatch) };\n  }\n  const put = await bucket.put(MANIFEST_KEY, JSON.stringify(manifest, null, 2), putOpts);\n  if (!put) {\n    throw new ManifestConflictError();\n  }\n  return { etag: objectEtag(put) };\n}\n\n// worker/src/devices.ts\nfunction deviceObjectKey(deviceId) {\n  return `devices/${deviceId}.b64`;\n}\nfunction isValidDeviceId(deviceId) {\n  if (!deviceId || deviceId.length > 128) return false;\n  if (deviceId.includes("/") || deviceId.includes("..") || deviceId.includes("\\\\")) return false;\n  return /^[A-Za-z0-9._-]+$/.test(deviceId);\n}\nfunction parseDevicePutBody(value) {\n  if (!value || typeof value !== "object") return null;\n  const v = value;\n  if (typeof v.content !== "string" || v.content.length === 0) return null;\n  if (typeof v.label !== "string") return null;\n  if (typeof v.pushedAt !== "string" || v.pushedAt.length === 0) return null;\n  return { content: v.content, label: v.label, pushedAt: v.pushedAt };\n}\nasync function getDeviceBlob(bucket, deviceId) {\n  const obj = await bucket.get(deviceObjectKey(deviceId));\n  if (!obj) return null;\n  const content = await obj.text();\n  return { content, etag: obj.httpEtag || obj.etag };\n}\nasync function putDeviceBlob(bucket, deviceId, body, opts = {}) {\n  const current = await readManifestRecord(bucket);\n  if (!current) {\n    throw new Error("manifest.json missing \\u2014 create it before uploading devices");\n  }\n  if (opts.ifMatch && !etagsMatch(opts.ifMatch, current.etag)) {\n    throw new ManifestConflictError("If-Match does not match current manifest ETag");\n  }\n  const entry = { id: deviceId, label: body.label, pushedAt: body.pushedAt };\n  const idx = current.manifest.devices.findIndex((d) => d.id === deviceId);\n  const devices = idx >= 0 ? current.manifest.devices.map((d, i) => i === idx ? entry : d) : [...current.manifest.devices, entry];\n  const next = { ...current.manifest, devices };\n  await writeManifest(bucket, next, { ifMatch: current.etag });\n  const put = await bucket.put(deviceObjectKey(deviceId), body.content, {\n    httpMetadata: { contentType: "text/plain; charset=utf-8" }\n  });\n  return { etag: put.httpEtag || put.etag, manifest: next };\n}\nasync function deleteDeviceBlob(bucket, deviceId) {\n  await bucket.delete(deviceObjectKey(deviceId));\n  const rec = await readManifestRecord(bucket);\n  if (!rec) return null;\n  const devices = rec.manifest.devices.filter((d) => d.id !== deviceId);\n  const next = { ...rec.manifest, devices };\n  await writeManifest(bucket, next, { ifMatch: rec.etag });\n  return next;\n}\n\n// worker/src/http.ts\nfunction json(data, status = 200, extraHeaders) {\n  return new Response(JSON.stringify(data), {\n    status,\n    headers: {\n      "content-type": "application/json; charset=utf-8",\n      "cache-control": "no-store",\n      ...extraHeaders\n    }\n  });\n}\n\n// worker/src/index.ts\nvar DEVICE_PATH = /^\\/v1\\/devices\\/([^/]+)$/;\nvar index_default = {\n  async fetch(request, env, _ctx) {\n    if (request.method === "OPTIONS") {\n      return handleOptions();\n    }\n    return withCors(await handleRequest(request, env));\n  }\n};\nasync function handleRequest(request, env) {\n  const url = new URL(request.url);\n  if (request.method === "GET" && url.pathname === "/health") {\n    return json({ ok: true, version: 1 });\n  }\n  if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {\n    const denied = await requireSyncToken(request, env);\n    if (denied) return denied;\n    try {\n      if (url.pathname === "/v1/manifest" && request.method === "GET") {\n        const rec = await readManifestRecord(env.VAULT_BUCKET);\n        if (!rec) {\n          return jsonError(404, "not_found", "manifest.json does not exist yet");\n        }\n        return json(rec.manifest, 200, { ETag: rec.etag });\n      }\n      if (url.pathname === "/v1/manifest" && request.method === "PUT") {\n        let body;\n        try {\n          body = await request.json();\n        } catch {\n          return jsonError(400, "bad_request", "Request body must be JSON");\n        }\n        if (!isManifest(body)) {\n          return jsonError(400, "bad_request", "Invalid manifest schema");\n        }\n        const ifMatch = request.headers.get("If-Match");\n        const current = await readManifestRecord(env.VAULT_BUCKET);\n        if (ifMatch) {\n          if (!current || !etagsMatch(ifMatch, current.etag)) {\n            return jsonError(412, "precondition_failed", "If-Match does not match current manifest ETag");\n          }\n        }\n        try {\n          const written = await writeManifest(\n            env.VAULT_BUCKET,\n            body,\n            current ? { ifMatch: current.etag } : {}\n          );\n          return json(body, 200, { ETag: written.etag });\n        } catch (err) {\n          if (err instanceof ManifestConflictError) {\n            return jsonError(412, "precondition_failed", err.message);\n          }\n          throw err;\n        }\n      }\n      const deviceMatch = DEVICE_PATH.exec(url.pathname);\n      if (deviceMatch) {\n        const deviceId = decodeURIComponent(deviceMatch[1]);\n        if (!isValidDeviceId(deviceId)) {\n          return jsonError(400, "bad_request", "Invalid device id");\n        }\n        if (request.method === "GET") {\n          const blob = await getDeviceBlob(env.VAULT_BUCKET, deviceId);\n          if (!blob) {\n            return jsonError(404, "not_found", `Device blob not found: ${deviceId}`);\n          }\n          return json({ content: blob.content, etag: blob.etag }, 200, { ETag: blob.etag });\n        }\n        if (request.method === "PUT") {\n          let body;\n          try {\n            body = await request.json();\n          } catch {\n            return jsonError(400, "bad_request", "Request body must be JSON");\n          }\n          const parsed = parseDevicePutBody(body);\n          if (!parsed) {\n            return jsonError(400, "bad_request", "Body must be { content, label, pushedAt }");\n          }\n          try {\n            const result = await putDeviceBlob(env.VAULT_BUCKET, deviceId, parsed, {\n              ifMatch: request.headers.get("If-Match")\n            });\n            return json({\n              content: parsed.content,\n              etag: result.etag,\n              manifest: result.manifest\n            }, 200, { ETag: result.etag });\n          } catch (err) {\n            const message = err instanceof Error ? err.message : String(err);\n            if (err instanceof ManifestConflictError) {\n              return jsonError(412, "precondition_failed", message);\n            }\n            if (message.includes("manifest.json missing")) {\n              return jsonError(409, "conflict", message);\n            }\n            throw err;\n          }\n        }\n        if (request.method === "DELETE") {\n          try {\n            const manifest = await deleteDeviceBlob(env.VAULT_BUCKET, deviceId);\n            return json({ ok: true, manifest });\n          } catch (err) {\n            if (err instanceof ManifestConflictError) {\n              return jsonError(412, "precondition_failed", err.message);\n            }\n            throw err;\n          }\n        }\n      }\n      return json(\n        { error: "not_found", message: `No route for ${request.method} ${url.pathname}` },\n        404\n      );\n    } catch (err) {\n      console.error(err);\n      return jsonError(500, "internal", "Internal error");\n    }\n  }\n  return json(\n    { error: "not_found", message: `No route for ${request.method} ${url.pathname}` },\n    404\n  );\n}\nexport {\n  index_default as default\n};\n';

// src/cloudflare-deploy.ts
var CF_API = "https://api.cloudflare.com/client/v4";
var CLOUDFLARE_DASHBOARD_URL = "https://dash.cloudflare.com/";
var TOKEN_PERMISSIONS = [
  { key: "workers_scripts", type: "edit" },
  { key: "workers_r2", type: "edit" },
  { key: "account_settings", type: "read" }
];
var CREATE_API_TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens?" + new URLSearchParams({
  permissionGroupKeys: JSON.stringify(TOKEN_PERMISSIONS),
  accountId: "*",
  zoneId: "all",
  name: "Voltius Cloudflare Sync"
}).toString();
var DEFAULT_WORKER_NAME = "voltius-cloudflare-sync";
var DEFAULT_BUCKET_NAME = "voltius-vault-sync";
var WORKER_COMPATIBILITY_DATE = "2025-09-06";
var WORKER_COMPATIBILITY_FLAGS = ["nodejs_compat"];
var WORKER_MODULE_NAME = "worker.mjs";
var CloudflareDeployError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "CloudflareDeployError";
  }
};
function authHeaders(apiToken, extra) {
  return {
    Authorization: `Bearer ${apiToken}`,
    Accept: "application/json",
    ...extra
  };
}
function formatCfErrors(payload, fallback) {
  const msgs = payload?.errors?.map((e) => e.message).filter(Boolean) ?? [];
  if (msgs.length) return msgs.join("; ");
  return fallback;
}
function accountUrl(accountId, path) {
  return `${CF_API}/accounts/${encodeURIComponent(accountId)}${path}`;
}
async function cfCall(http, url, context, init, tolerate) {
  const res = await send(http, url, init);
  const payload = parseJson(res.body);
  if (tolerate?.(res, payload)) return null;
  if (res.status === 401 || res.status === 403) {
    throw new CloudflareDeployError(
      res.status,
      `${context}: Cloudflare rejected the API token (${res.status}). Check Workers Scripts Edit, Workers R2 Storage Edit, and Account Settings Read.`
    );
  }
  if (!res.ok || payload?.success === false) {
    throw new CloudflareDeployError(res.status, `${context}: ${formatCfErrors(payload, res.body)}`);
  }
  return payload?.result ?? null;
}
function generateSyncToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function buildMultipart(parts) {
  let boundary = "";
  do {
    boundary = `----voltius-${crypto.randomUUID()}`;
  } while (parts.some((p) => p.content.includes(boundary)));
  const body = parts.map((p) => {
    const filename = p.filename ? `; filename="${p.filename}"` : "";
    return `--${boundary}\r
Content-Disposition: form-data; name="${p.name}"${filename}\r
Content-Type: ${p.contentType}\r
\r
${p.content}\r
`;
  }).join("") + `--${boundary}--\r
`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
async function ensureR2Bucket(http, accountId, apiToken, bucketName) {
  await cfCall(
    http,
    accountUrl(accountId, "/r2/buckets"),
    "ensureR2Bucket",
    {
      method: "POST",
      headers: authHeaders(apiToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: bucketName })
    },
    (res, payload) => {
      if (res.status === 409) return true;
      const joined = formatCfErrors(payload, res.body).toLowerCase();
      return res.status === 400 && (joined.includes("already exists") || joined.includes("bucket already") || !!payload?.errors?.some((e) => e.code === 10004 || e.code === 10007));
    }
  );
}
async function uploadWorkerScript(http, accountId, apiToken, workerName, bucketName, syncToken) {
  const metadata = {
    main_module: WORKER_MODULE_NAME,
    compatibility_date: WORKER_COMPATIBILITY_DATE,
    compatibility_flags: [...WORKER_COMPATIBILITY_FLAGS],
    bindings: [
      { type: "r2_bucket", name: "VAULT_BUCKET", bucket_name: bucketName },
      { type: "secret_text", name: "SYNC_TOKEN", text: syncToken }
    ]
  };
  const { body, contentType } = buildMultipart([
    { name: "metadata", contentType: "application/json", content: JSON.stringify(metadata) },
    {
      name: WORKER_MODULE_NAME,
      filename: WORKER_MODULE_NAME,
      contentType: "application/javascript+module",
      content: worker_default
    }
  ]);
  await cfCall(
    http,
    accountUrl(accountId, `/workers/scripts/${encodeURIComponent(workerName)}`),
    "uploadWorkerScript",
    { method: "PUT", headers: authHeaders(apiToken, { "Content-Type": contentType }), body }
  );
}
async function putWorkerSecret(http, accountId, apiToken, workerName, name, text) {
  await cfCall(
    http,
    accountUrl(accountId, `/workers/scripts/${encodeURIComponent(workerName)}/secrets`),
    "putWorkerSecret",
    {
      method: "PUT",
      headers: authHeaders(apiToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name, text, type: "secret_text" })
    }
  );
}
async function getWorkersSubdomain(http, accountId, apiToken) {
  const result = await cfCall(
    http,
    accountUrl(accountId, "/workers/subdomain"),
    "getWorkersSubdomain",
    { method: "GET", headers: authHeaders(apiToken) },
    (res) => res.status === 404
  );
  return result?.subdomain?.trim() || null;
}
async function enableWorkersDev(http, accountId, apiToken, workerName) {
  await cfCall(
    http,
    accountUrl(accountId, `/workers/scripts/${encodeURIComponent(workerName)}/subdomain`),
    "enableWorkersDev",
    {
      method: "POST",
      headers: authHeaders(apiToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled: true })
    },
    (res) => res.status === 404
  );
}
async function deployWorker(http, input) {
  const accountId = input.accountId.trim();
  const apiToken = input.apiToken.trim();
  const workerName = (input.workerName.trim() || DEFAULT_WORKER_NAME).replace(/[^a-zA-Z0-9_-]/g, "-");
  const bucketName = (input.bucketName.trim() || DEFAULT_BUCKET_NAME).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const syncToken = input.syncToken.trim();
  if (!accountId) throw new CloudflareDeployError(0, "Cloudflare Account ID is required");
  if (!apiToken) throw new CloudflareDeployError(0, "Cloudflare API token is required");
  if (!syncToken) throw new CloudflareDeployError(0, "Sync token is required before deploy");
  await ensureR2Bucket(http, accountId, apiToken, bucketName);
  await uploadWorkerScript(http, accountId, apiToken, workerName, bucketName, syncToken);
  await putWorkerSecret(http, accountId, apiToken, workerName, "SYNC_TOKEN", syncToken);
  try {
    await enableWorkersDev(http, accountId, apiToken, workerName);
  } catch {
  }
  const subdomain = await getWorkersSubdomain(http, accountId, apiToken);
  if (subdomain) {
    return { workerUrl: `https://${workerName}.${subdomain}.workers.dev`, subdomain };
  }
  return { workerUrl: "", subdomain: null };
}

// ../shared/vault-sync/src/ui/wizard.tsx
import { useState as useState3 } from "react";
import { Icon as Icon3 } from "@voltius/ui";
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function StepCard({
  n,
  title,
  state,
  summary,
  onChange,
  children
}) {
  const badge = state === "done" ? /* @__PURE__ */ jsx3(
    "span",
    {
      className: "flex items-center justify-center w-5 h-5 rounded-full",
      style: { background: "var(--t-status-connected)", color: "var(--t-bg-base)" },
      children: /* @__PURE__ */ jsx3(Icon3, { icon: "lucide:check", width: 12 })
    }
  ) : /* @__PURE__ */ jsx3(
    "span",
    {
      className: `flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-semibold ${state === "active" ? "bg-(--t-accent) text-white" : "bg-(--t-bg-base) text-(--t-text-dim) border border-(--t-border)"}`,
      children: n
    }
  );
  return /* @__PURE__ */ jsxs3(
    "div",
    {
      className: `flex flex-col gap-3 p-4 rounded-xl bg-(--t-bg-elevated) border ${state === "active" ? "border-(--t-border-hover)" : "border-(--t-border)"} ${state === "locked" ? "opacity-60" : ""}`,
      children: [
        /* @__PURE__ */ jsxs3("div", { className: "flex items-center gap-2", children: [
          badge,
          /* @__PURE__ */ jsx3("p", { className: "flex-1 text-sm font-medium text-(--t-text-primary)", children: title }),
          state === "done" && onChange && /* @__PURE__ */ jsx3(LinkButton, { onClick: onChange, children: "Change" })
        ] }),
        state === "done" && summary && /* @__PURE__ */ jsx3("div", { className: "text-xs text-(--t-text-dim) pl-7", children: summary }),
        state === "active" && /* @__PURE__ */ jsx3("div", { className: "flex flex-col gap-3", children })
      ]
    }
  );
}
function ChoiceTile({
  icon,
  title,
  description,
  onClick
}) {
  return /* @__PURE__ */ jsxs3(
    "button",
    {
      type: "button",
      onClick,
      className: "flex-1 flex flex-col items-start gap-1 p-3 rounded-lg text-left bg-(--t-bg-base) border border-(--t-border) hover:border-(--t-border-hover) transition-colors",
      style: { minWidth: "12rem" },
      children: [
        /* @__PURE__ */ jsxs3("span", { className: "flex items-center gap-2 text-sm font-medium text-(--t-text-primary)", children: [
          /* @__PURE__ */ jsx3(Icon3, { icon, width: 15 }),
          title
        ] }),
        /* @__PURE__ */ jsx3("span", { className: "text-xs text-(--t-text-dim)", children: description })
      ]
    }
  );
}
function ActionRow({ children, reason }) {
  return /* @__PURE__ */ jsxs3("div", { className: "flex flex-wrap items-center gap-3", children: [
    children,
    reason && /* @__PURE__ */ jsx3("span", { className: "text-xs text-(--t-text-dim)", children: reason })
  ] });
}
function PassphraseStep({
  n,
  api,
  engine,
  connection,
  busy,
  run,
  existsHint,
  onDone
}) {
  const [passphrase, setPassphrase] = useState3("");
  const [confirm, setConfirm] = useState3("");
  const exists = connection?.vault === "exists";
  const reason = !passphrase ? "Enter a passphrase" : connection?.vault === "empty" && passphrase !== confirm ? "The passphrases do not match" : null;
  const finish = () => run(exists ? "Linking\u2026" : "Creating\u2026", async () => {
    if (!connection) return;
    if (exists) await engine.linkVault(connection.store, passphrase, connection.values);
    else await engine.createVault(connection.store, passphrase, connection.values);
    engine.startPoll(await api.storage.get("pollIntervalSeconds") ?? 60);
    await engine.syncNow();
    onDone();
  });
  return /* @__PURE__ */ jsxs3(StepCard, { n, title: exists ? "Unlock your vault" : "Choose an encryption passphrase", state: connection ? "active" : "locked", children: [
    exists ? /* @__PURE__ */ jsx3(Hint, { children: existsHint }) : /* @__PURE__ */ jsx3(Hint, { children: "Your data is encrypted on this device with this passphrase before it leaves. You will need it on every device, and it cannot be recovered." }),
    /* @__PURE__ */ jsx3(SecretInput, { label: "Passphrase", value: passphrase, onChange: setPassphrase, placeholder: "Strong passphrase" }),
    connection?.vault === "empty" && /* @__PURE__ */ jsx3(SecretInput, { label: "Confirm passphrase", value: confirm, onChange: setConfirm, placeholder: "Type it again" }),
    /* @__PURE__ */ jsx3(ActionRow, { reason: busy ?? reason, children: /* @__PURE__ */ jsx3(Btn, { onClick: finish, disabled: !!reason, busy: !!busy, children: exists ? "Link vault" : "Create vault" }) })
  ] });
}

// src/SetupWizard.tsx
import { Fragment as Fragment2, jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
var HEALTH_ATTEMPTS_AFTER_DEPLOY = 20;
var HEALTH_RETRY_MS = 3e3;
var ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForWorker(api, workerUrl, attempts) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      if ((await getHealth(api.http, workerUrl)).ok) return;
    } catch (err) {
      lastError = err;
    }
    if (i < attempts - 1) await sleep(HEALTH_RETRY_MS);
  }
  throw new Error(`Could not reach the Worker at ${workerUrl}. ${lastError ? describeError(lastError) : ""}`.trim());
}
function SetupWizard({ api, engine, onDone }) {
  const [mode, setMode] = useState4(null);
  const [connection, setConnection] = useState4(null);
  const [connectedUrl, setConnectedUrl] = useState4("");
  const { busy, setBusy, error, setError, run } = useAction();
  const [accountId, setAccountId] = useState4("");
  const [apiToken, setApiToken] = useState4("");
  const [showAdvanced, setShowAdvanced] = useState4(false);
  const [workerName, setWorkerName] = useState4(DEFAULT_WORKER_NAME);
  const [bucketName, setBucketName] = useState4(DEFAULT_BUCKET_NAME);
  const [deployedToken, setDeployedToken] = useState4(null);
  const [workerUrl, setWorkerUrl] = useState4("");
  const [token, setToken] = useState4("");
  useEffect2(() => {
    void Promise.all([
      api.storage.get("cfAccountId"),
      api.storage.get("cfWorkerName"),
      api.storage.get("cfBucketName")
    ]).then(([id, name, bucket]) => {
      if (id) setAccountId(id);
      if (name) setWorkerName(name);
      if (bucket) setBucketName(bucket);
    });
  }, [api]);
  async function connect(url, syncToken, healthAttempts) {
    const normalized = normalizeWorkerUrl(url);
    await waitForWorker(api, normalized, healthAttempts);
    const store = new WorkerStore(api.http, normalized, syncToken);
    const vault = await engine.detectVault(store);
    setConnectedUrl(normalized);
    setConnection({ store, vault, values: { storage: { workerUrl: normalized }, vault: { syncToken } } });
  }
  const deploy = () => run("Deploying\u2026", async () => {
    await Promise.all([
      api.storage.set("cfAccountId", accountId.trim()),
      api.storage.set("cfWorkerName", workerName.trim() || DEFAULT_WORKER_NAME),
      api.storage.set("cfBucketName", bucketName.trim() || DEFAULT_BUCKET_NAME)
    ]);
    const syncToken = generateSyncToken();
    const result = await deployWorker(api.http, { accountId, apiToken, workerName, bucketName, syncToken });
    setDeployedToken(syncToken);
    setToken(syncToken);
    if (!result.workerUrl) return;
    setWorkerUrl(result.workerUrl);
    setBusy("Waiting for the Worker to come online\u2026");
    await connect(result.workerUrl, syncToken, HEALTH_ATTEMPTS_AFTER_DEPLOY);
  });
  const resetConnection = () => {
    setConnection(null);
    setError(null);
  };
  const step1 = mode ? "done" : "active";
  const step2 = !mode ? "locked" : connection ? "done" : "active";
  const deployReason = !accountId.trim() ? "Enter your Account ID" : !ACCOUNT_ID_RE.test(accountId.trim()) ? "The Account ID is 32 letters and digits" : !apiToken.trim() ? "Enter an API token" : null;
  const connectReason = !workerUrl.trim() ? "Enter the Worker URL" : !token.trim() ? "Enter the sync token" : null;
  return /* @__PURE__ */ jsxs4("div", { className: "flex flex-col gap-3", children: [
    error && /* @__PURE__ */ jsx4(ErrorBanner, { message: error }),
    /* @__PURE__ */ jsx4(
      StepCard,
      {
        n: 1,
        title: "Where is your sync Worker?",
        state: step1,
        summary: mode === "deploy" ? "Deploy a new Worker to my Cloudflare account" : "Use a Worker I already have",
        onChange: busy ? void 0 : () => {
          setMode(null);
          setDeployedToken(null);
          setToken("");
          setWorkerUrl("");
          resetConnection();
        },
        children: /* @__PURE__ */ jsxs4("div", { className: "flex flex-wrap gap-2", children: [
          /* @__PURE__ */ jsx4(
            ChoiceTile,
            {
              icon: "lucide:rocket",
              title: "Deploy one for me",
              description: "Recommended. Voltius creates the Worker and its R2 bucket in your Cloudflare account.",
              onClick: () => setMode("deploy")
            }
          ),
          /* @__PURE__ */ jsx4(
            ChoiceTile,
            {
              icon: "lucide:link",
              title: "I already have one",
              description: "You set Cloudflare Sync up on another device, or deployed the Worker yourself.",
              onClick: () => setMode("existing")
            }
          )
        ] })
      }
    ),
    /* @__PURE__ */ jsxs4(
      StepCard,
      {
        n: 2,
        title: mode === "existing" ? "Connect to your Worker" : "Deploy the Worker",
        state: step2,
        summary: connection && /* @__PURE__ */ jsxs4("div", { className: "flex flex-col gap-1", children: [
          /* @__PURE__ */ jsx4("span", { className: "font-mono", children: connectedUrl }),
          deployedToken && /* @__PURE__ */ jsxs4("span", { children: [
            "Sync token generated.",
            " ",
            /* @__PURE__ */ jsx4(LinkButton, { onClick: () => void copyToken(api, deployedToken), children: "Copy it" }),
            " ",
            "to set up your other devices."
          ] })
        ] }),
        onChange: busy ? void 0 : resetConnection,
        children: [
          mode === "deploy" && !deployedToken && /* @__PURE__ */ jsxs4(Fragment2, { children: [
            /* @__PURE__ */ jsx4(
              TextInput,
              {
                label: "Cloudflare Account ID",
                value: accountId,
                onChange: setAccountId,
                placeholder: "32 letters and digits",
                hint: /* @__PURE__ */ jsxs4(Fragment2, { children: [
                  "In the ",
                  /* @__PURE__ */ jsx4(LinkButton, { onClick: () => openExternal(CLOUDFLARE_DASHBOARD_URL), children: "Cloudflare dashboard" }),
                  ", press Ctrl+K (\u2318K on macOS), search ",
                  /* @__PURE__ */ jsx4("span", { className: "font-medium", children: "Account ID" }),
                  " and select it to copy it."
                ] })
              }
            ),
            /* @__PURE__ */ jsx4(
              SecretInput,
              {
                label: "Cloudflare API token",
                value: apiToken,
                onChange: setApiToken,
                placeholder: "Paste the token",
                hint: /* @__PURE__ */ jsxs4(Fragment2, { children: [
                  /* @__PURE__ */ jsx4(LinkButton, { onClick: () => openExternal(CREATE_API_TOKEN_URL), children: "Create a token" }),
                  " with the permissions already selected, then choose Continue to summary \u2192 Create Token. Used once for the deploy and never saved."
                ] })
              }
            ),
            /* @__PURE__ */ jsxs4(
              "button",
              {
                type: "button",
                className: "flex items-center gap-1 self-start text-xs text-(--t-text-dim) hover:text-(--t-text-muted)",
                onClick: () => setShowAdvanced((s) => !s),
                children: [
                  /* @__PURE__ */ jsx4(Icon4, { icon: showAdvanced ? "lucide:chevron-down" : "lucide:chevron-right", width: 12 }),
                  "Advanced"
                ]
              }
            ),
            showAdvanced && /* @__PURE__ */ jsxs4("div", { className: "flex flex-col gap-3 border-l border-(--t-border)", style: { paddingLeft: "1rem" }, children: [
              /* @__PURE__ */ jsx4(TextInput, { label: "Worker name", value: workerName, onChange: setWorkerName, placeholder: DEFAULT_WORKER_NAME }),
              /* @__PURE__ */ jsx4(
                TextInput,
                {
                  label: "R2 bucket name",
                  value: bucketName,
                  onChange: setBucketName,
                  placeholder: DEFAULT_BUCKET_NAME,
                  hint: "Created if it does not exist."
                }
              )
            ] }),
            /* @__PURE__ */ jsx4(ActionRow, { reason: busy ?? deployReason, children: /* @__PURE__ */ jsx4(Btn, { onClick: deploy, disabled: !!deployReason, busy: !!busy, children: "Deploy Worker" }) })
          ] }),
          (mode === "existing" || deployedToken) && /* @__PURE__ */ jsxs4(Fragment2, { children: [
            deployedToken && /* @__PURE__ */ jsxs4(Hint, { children: [
              "The Worker is deployed with a new sync token. Paste its address to continue: in the",
              " ",
              /* @__PURE__ */ jsx4(LinkButton, { onClick: () => openExternal(CLOUDFLARE_DASHBOARD_URL), children: "Cloudflare dashboard" }),
              ", open Workers & Pages \u2192 ",
              workerName.trim() || DEFAULT_WORKER_NAME,
              " and copy the workers.dev URL."
            ] }),
            /* @__PURE__ */ jsx4(
              TextInput,
              {
                label: "Worker URL",
                value: workerUrl,
                onChange: setWorkerUrl,
                placeholder: "https://voltius-cloudflare-sync.<your-subdomain>.workers.dev",
                hint: mode === "existing" ? "Shown under Settings \u2192 Cloudflare Sync on a device that is already set up." : void 0
              }
            ),
            mode === "existing" && /* @__PURE__ */ jsx4(
              SecretInput,
              {
                label: "Sync token",
                value: token,
                onChange: setToken,
                placeholder: "The Worker's SYNC_TOKEN",
                hint: "Copy it from a device that is already set up, or use the SYNC_TOKEN you set when deploying."
              }
            ),
            /* @__PURE__ */ jsx4(ActionRow, { reason: busy ?? connectReason, children: /* @__PURE__ */ jsx4(
              Btn,
              {
                onClick: () => run("Connecting\u2026", () => connect(workerUrl, token, 1)),
                disabled: !!connectReason,
                busy: !!busy,
                children: "Connect"
              }
            ) })
          ] })
        ]
      }
    ),
    /* @__PURE__ */ jsx4(
      PassphraseStep,
      {
        n: 3,
        api,
        engine,
        connection,
        busy,
        run,
        existsHint: "This Worker already holds a synced vault. Enter the passphrase you chose when you created it.",
        onDone
      },
      connection ? "connected" : "none"
    )
  ] });
}

// src/SettingsPage.tsx
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function ConnectionCard({ api }) {
  const [workerUrl, setWorkerUrl] = useState5("");
  const { error, run } = useAction();
  useEffect3(() => {
    void api.storage.get("workerUrl").then((u) => setWorkerUrl(u ?? ""));
  }, [api]);
  const copyStoredToken = () => run("copy", async () => copyToken(api, await api.vault.get("syncToken")));
  return /* @__PURE__ */ jsxs5(Card, { title: "Connection", children: [
    /* @__PURE__ */ jsxs5("div", { className: "flex flex-col gap-1", children: [
      /* @__PURE__ */ jsx5("span", { className: "text-xs font-medium text-(--t-text-muted)", children: "Worker URL" }),
      /* @__PURE__ */ jsx5("span", { className: "text-sm font-mono text-(--t-text-primary) break-all", children: workerUrl })
    ] }),
    error && /* @__PURE__ */ jsx5(ErrorBanner, { message: error }),
    /* @__PURE__ */ jsxs5(Hint, { children: [
      "To add another device, open Cloudflare Sync there, choose ",
      /* @__PURE__ */ jsx5("span", { className: "font-medium", children: "I already have one" }),
      ", and enter this Worker URL, the sync token (",
      /* @__PURE__ */ jsx5(LinkButton, { onClick: () => void copyStoredToken(), children: "copy it" }),
      ") and your passphrase."
    ] })
  ] });
}
function createSettingsPage(api, engine) {
  return function CloudflareSyncSettingsPage() {
    return /* @__PURE__ */ jsx5(
      SettingsShell,
      {
        api,
        engine,
        icon: "lucide:cloud",
        intro: "Sync your data across devices through your own Cloudflare Worker and R2 bucket. Everything is encrypted on this device first; the Worker only ever stores ciphertext.",
        wizard: (onDone) => /* @__PURE__ */ jsx5(SetupWizard, { api, engine, onDone }),
        connection: /* @__PURE__ */ jsx5(ConnectionCard, { api }),
        disconnectHint: "Stops syncing on this device and forgets the Worker URL, sync token and passphrase. Nothing is deleted from the Worker."
      }
    );
  };
}

// src/index.tsx
function register(api) {
  api.i18n.register(messages);
  const engine = createCloudflareEngine(api);
  api.ui.registerSettingsPage({
    id: "cloudflare-sync-settings",
    label: () => api.i18n.t("settingsLabel"),
    icon: "simple-icons:cloudflare",
    component: createSettingsPage(api, engine)
  });
  return engine.activate();
}
export {
  register as default
};
