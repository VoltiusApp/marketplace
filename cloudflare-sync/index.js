// src/i18n.ts
var messages = {
  en: { settingsLabel: "Cloudflare Sync" },
  fr: { settingsLabel: "Synchronisation Cloudflare" },
  ru: { settingsLabel: "\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u044F Cloudflare" },
  zh: { settingsLabel: "Cloudflare \u540C\u6B65" }
};

// src/SettingsPage.tsx
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@voltius/ui";

// src/crypto.ts
function generateSaltHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// src/http.ts
var REQUEST_TIMEOUT_MS = 6e4;
function parseJson(body) {
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    return null;
  }
}
async function send(http, url, init2 = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${timeoutMs / 1e3}s: ${url}`));
    }, timeoutMs);
  });
  const request = (async () => {
    const res = await http.stream(url, { ...init2, signal: controller.signal });
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
async function call(http, workerUrl, path, context, init2 = {}) {
  const res = await send(http, `${normalizeBaseUrl(workerUrl)}${path}`, init2);
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
async function getDeviceBlobs(http, workerUrl, token, deviceIds) {
  const blobs = [];
  for (const id of deviceIds) {
    try {
      blobs.push(await getDeviceBlob(http, workerUrl, token, id));
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 404) continue;
      throw err;
    }
  }
  return blobs;
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

// src/sync-engine.ts
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
var _api;
var _status = "idle";
var _lastSync = null;
var _error = null;
var _blobSizeBytes = null;
var _configured = false;
var _pollInterval = null;
var _consecutiveFailures = 0;
var _failureBannerId = null;
var _lastSeenPushedAt = {};
function getCloudflareSyncState() {
  return {
    status: _status,
    lastSync: _lastSync,
    error: _error,
    configured: _configured,
    blobSizeBytes: _blobSizeBytes
  };
}
function publish() {
  _api.ui.publishState("sync-state", getCloudflareSyncState());
}
function setState(status, error) {
  _status = status;
  _error = error ?? null;
  if (status === "success") _lastSync = /* @__PURE__ */ new Date();
  publish();
}
function init(api) {
  _api = api;
  publish();
  isConfigured().then((c) => {
    _configured = c;
    publish();
  }).catch(() => {
  });
}
async function getWorkerUrl() {
  return _api.storage.get("workerUrl");
}
async function getToken() {
  return _api.vault.get("syncToken");
}
async function getPassphrase() {
  return _api.vault.get("passphrase");
}
async function getDeviceId() {
  let id = await _api.storage.get("deviceId");
  if (!id) {
    id = crypto.randomUUID();
    await _api.storage.set("deviceId", id);
  }
  return id;
}
async function getDeviceLabel() {
  const stored = await _api.storage.get("deviceLabel");
  if (stored) return stored;
  const ua = navigator.userAgent;
  const match = ua.match(/\(([^)]+)\)/);
  return match ? match[1].split(";")[0].trim() : "Unknown device";
}
async function isConfigured() {
  const [url, token, passphrase] = await Promise.all([
    getWorkerUrl(),
    getToken(),
    getPassphrase()
  ]);
  return !!(url && token && passphrase);
}
async function getEncKey(salt) {
  const passphrase = await getPassphrase();
  if (!passphrase) {
    throw new Error("cloudflare-sync: passphrase is required (do not derive from the sync token)");
  }
  return _api.crypto.deriveKey(passphrase, salt);
}
async function requireConfig() {
  const [workerUrl, token] = await Promise.all([getWorkerUrl(), getToken()]);
  if (!workerUrl || !token) {
    throw new Error("cloudflare-sync: not configured");
  }
  return { workerUrl, token };
}
function markConfigured(value) {
  if (_configured === value) {
    publish();
    return;
  }
  _configured = value;
  publish();
}
async function setupNewVault(workerUrl, token, passphrase, opts = {}) {
  const normalized = normalizeWorkerUrl(workerUrl);
  if (!token.trim()) throw new Error("cloudflare-sync: sync token is required");
  if (!passphrase) throw new Error("cloudflare-sync: passphrase is required");
  let remoteExists = false;
  try {
    await getManifest(_api.http, normalized, token);
    remoteExists = true;
  } catch (err) {
    if (err instanceof WorkerApiError && err.status === 404) {
      remoteExists = false;
    } else {
      throw err;
    }
  }
  if (remoteExists && !opts.overwrite) {
    throw new Error(
      "cloudflare-sync: remote vault already exists \u2014 use Link existing, or confirm overwrite"
    );
  }
  await _api.storage.set("workerUrl", normalized);
  await _api.vault.set("syncToken", token);
  await _api.vault.set("passphrase", passphrase);
  const salt = generateSaltHex();
  const deviceId = await getDeviceId();
  const deviceLabel = await getDeviceLabel();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const manifest = {
    schema: 1,
    salt,
    devices: [{ id: deviceId, label: deviceLabel, pushedAt: now }]
  };
  await putManifest(_api.http, normalized, token, manifest);
  const encKey = await getEncKey(salt);
  const blob = await _api.sync.exportState(encKey, deviceId);
  await putDeviceBlob(_api.http, normalized, token, deviceId, {
    content: blob,
    label: deviceLabel,
    pushedAt: now
  });
  _lastSeenPushedAt[deviceId] = now;
  _blobSizeBytes = Math.round(blob.length * 3 / 4);
  markConfigured(true);
}
var WRONG_PASSPHRASE_MSG = "cloudflare-sync: passphrase does not match the remote vault \u2014 check it and try again";
async function restoreSecret(key, previous) {
  if (previous === null) await _api.vault.delete(key);
  else await _api.vault.set(key, previous);
}
async function restoreStorage(key, previous) {
  if (previous === null) await _api.storage.delete(key);
  else await _api.storage.set(key, previous);
}
async function linkExistingVault(workerUrl, token, passphrase) {
  const normalized = normalizeWorkerUrl(workerUrl);
  if (!token.trim()) throw new Error("cloudflare-sync: sync token is required");
  if (!passphrase) throw new Error("cloudflare-sync: passphrase is required");
  const manifest = await getManifest(_api.http, normalized, token);
  const [prevUrl, prevToken, prevPass] = await Promise.all([
    _api.storage.get("workerUrl"),
    _api.vault.get("syncToken"),
    _api.vault.get("passphrase")
  ]);
  await _api.storage.set("workerUrl", normalized);
  await _api.vault.set("syncToken", token);
  await _api.vault.set("passphrase", passphrase);
  const rollback = async () => {
    await Promise.all([
      restoreStorage("workerUrl", prevUrl),
      restoreSecret("syncToken", prevToken),
      restoreSecret("passphrase", prevPass)
    ]);
    markConfigured(!!(prevUrl && prevToken && prevPass));
  };
  try {
    if (manifest.devices.length > 0) {
      const blobs = await getDeviceBlobs(
        _api.http,
        normalized,
        token,
        manifest.devices.map((d) => d.id)
      );
      if (blobs.length > 0) {
        const encKey = await getEncKey(manifest.salt);
        try {
          await _api.sync.importStates(encKey, [blobs[0]]);
        } catch {
          throw new Error(WRONG_PASSPHRASE_MSG);
        }
      }
    }
    markConfigured(true);
  } catch (err) {
    await rollback();
    throw err;
  }
}
async function disconnect() {
  await Promise.all([
    _api.storage.delete("workerUrl"),
    _api.vault.delete("syncToken"),
    _api.vault.delete("passphrase")
  ]);
  stopPoll();
  markConfigured(false);
  setState("idle");
}
async function removeRemoteDevice(deviceId) {
  const { workerUrl, token } = await requireConfig();
  await deleteDevice(_api.http, workerUrl, token, deviceId);
  delete _lastSeenPushedAt[deviceId];
}
async function push() {
  const { workerUrl, token } = await requireConfig();
  if (!await getPassphrase()) return;
  const deviceId = await getDeviceId();
  const deviceLabel = await getDeviceLabel();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const { manifest, etag } = await getManifestWithEtag(_api.http, workerUrl, token);
  const encKey = await getEncKey(manifest.salt);
  const blob = await _api.sync.exportState(encKey, deviceId);
  await putDeviceBlob(_api.http, workerUrl, token, deviceId, {
    content: blob,
    label: deviceLabel,
    pushedAt: now
  }, { ifMatch: etag });
  _blobSizeBytes = Math.round(blob.length * 3 / 4);
  _lastSeenPushedAt[deviceId] = now;
}
async function pull() {
  const { workerUrl, token } = await requireConfig();
  if (!await getPassphrase()) return false;
  const deviceId = await getDeviceId();
  const manifest = await getManifest(_api.http, workerUrl, token);
  const encKey = await getEncKey(manifest.salt);
  const remoteDevices = manifest.devices.filter((d) => d.id !== deviceId);
  if (remoteDevices.length === 0) return false;
  const changedDevices = remoteDevices.filter((d) => d.pushedAt !== _lastSeenPushedAt[d.id]);
  if (changedDevices.length === 0) return false;
  const blobs = await getDeviceBlobs(
    _api.http,
    workerUrl,
    token,
    changedDevices.map((d) => d.id)
  );
  if (blobs.length === 0) return false;
  await _api.sync.importStates(encKey, blobs);
  for (const d of changedDevices) _lastSeenPushedAt[d.id] = d.pushedAt;
  return true;
}
var MAX_SYNC_CONFLICT_RETRIES = 3;
async function syncNow(opts = {}) {
  if (!await isConfigured()) return;
  if (_status === "syncing") return;
  setState("syncing");
  let progress = null;
  if (opts.showProgress) {
    progress = _api.notifications.progress("Syncing via Cloudflare\u2026", { indeterminate: true });
  }
  try {
    let lastConflict;
    for (let attempt = 0; attempt <= MAX_SYNC_CONFLICT_RETRIES; attempt++) {
      try {
        await pull();
        await push();
        lastConflict = null;
        break;
      } catch (err) {
        lastConflict = err;
        const conflict = err instanceof WorkerApiError && isConflictStatus(err.status);
        if (!conflict || attempt === MAX_SYNC_CONFLICT_RETRIES) throw err;
      }
    }
    if (lastConflict) throw lastConflict;
    _consecutiveFailures = 0;
    if (_failureBannerId) {
      _failureBannerId.dismiss();
      _failureBannerId = null;
    }
    if (progress) progress.finish("Cloudflare sync complete");
    else if (opts.showProgress) {
      _api.notifications.toast("Cloudflare sync complete", { severity: "success" });
    }
    await _api.storage.set("lastSync", (/* @__PURE__ */ new Date()).toISOString());
    setState("success");
  } catch (err) {
    if (progress) progress.error("Cloudflare sync failed");
    onSyncError(err);
  }
}
function onSyncError(err) {
  _consecutiveFailures++;
  if (err instanceof WorkerApiError) {
    if (err.status === 401) {
      stopPoll();
      setState("error", "Sync token is invalid or expired");
      if (!_failureBannerId) {
        _failureBannerId = _api.notifications.banner(
          "Cloudflare Sync: sync token is invalid or expired",
          { severity: "error" }
        );
      }
      return;
    }
    if (isConflictStatus(err.status)) {
      setState("error", "Remote changed during sync \u2014 try again");
      return;
    }
    if (err.status === 404) {
      stopPoll();
      setState("error", "Vault not found \u2014 re-configure in Settings");
      if (!_failureBannerId) {
        _failureBannerId = _api.notifications.banner(
          "Cloudflare Sync: vault not found \u2014 re-configure in Settings",
          { severity: "error" }
        );
      }
      return;
    }
  }
  const isOffline = typeof navigator !== "undefined" && !navigator.onLine;
  const msg = err instanceof Error ? err.message : String(err);
  setState(isOffline ? "offline" : "error", isOffline ? void 0 : msg);
  if (_consecutiveFailures >= 3 && !_failureBannerId) {
    _failureBannerId = _api.notifications.banner(`Cloudflare Sync: repeated failures \u2014 ${msg}`, {
      severity: "warning"
    });
  } else if (_consecutiveFailures < 3) {
    _api.notifications.toast("Cloudflare sync skipped \u2014 offline?", { severity: "warning" });
  }
}
function startPoll(intervalSeconds) {
  stopPoll();
  _pollInterval = setInterval(() => {
    void syncNow();
  }, intervalSeconds * 1e3);
}
function stopPoll() {
  if (_pollInterval !== null) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
}

// dist/worker.mjs
var worker_default = '// worker/src/auth.ts\nasync function sha256Bytes(value) {\n  const digest = await crypto.subtle.digest(\n    "SHA-256",\n    new TextEncoder().encode(value)\n  );\n  return new Uint8Array(digest);\n}\nfunction timingSafeEqualBytes(a, b) {\n  if (a.length !== b.length) return false;\n  let mismatch = 0;\n  for (let i = 0; i < a.length; i++) {\n    mismatch |= a[i] ^ b[i];\n  }\n  return mismatch === 0;\n}\nfunction extractBearerToken(request) {\n  const header = request.headers.get("authorization");\n  if (!header) return null;\n  const match = /^Bearer\\s+(.+)$/i.exec(header.trim());\n  if (!match) return null;\n  const token = match[1].trim();\n  return token.length > 0 ? token : null;\n}\nasync function requireSyncToken(request, env) {\n  const expected = env.SYNC_TOKEN;\n  if (!expected) {\n    return jsonError(\n      500,\n      "misconfigured",\n      "SYNC_TOKEN secret is not configured on this Worker"\n    );\n  }\n  const provided = extractBearerToken(request);\n  if (!provided) {\n    return jsonError(401, "unauthorized", "Invalid or missing bearer token");\n  }\n  const [got, want] = await Promise.all([sha256Bytes(provided), sha256Bytes(expected)]);\n  if (!timingSafeEqualBytes(got, want)) {\n    return jsonError(401, "unauthorized", "Invalid or missing bearer token");\n  }\n  return null;\n}\nfunction jsonError(status, error, message) {\n  return new Response(JSON.stringify({ error, message }), {\n    status,\n    headers: {\n      "content-type": "application/json; charset=utf-8",\n      "cache-control": "no-store",\n      ...status === 401 ? { "www-authenticate": \'Bearer realm="voltius-cloudflare-sync"\' } : {}\n    }\n  });\n}\n\n// worker/src/cors.ts\nvar CORS_HEADERS = {\n  "access-control-allow-origin": "*",\n  "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS",\n  "access-control-allow-headers": "authorization, content-type, if-match",\n  "access-control-expose-headers": "etag",\n  "access-control-max-age": "86400"\n};\nfunction withCors(response) {\n  const headers = new Headers(response.headers);\n  for (const [k, v] of Object.entries(CORS_HEADERS)) {\n    headers.set(k, v);\n  }\n  return new Response(response.body, {\n    status: response.status,\n    statusText: response.statusText,\n    headers\n  });\n}\nfunction handleOptions() {\n  return new Response(null, { status: 204, headers: CORS_HEADERS });\n}\n\n// worker/src/manifest.ts\nvar MANIFEST_KEY = "manifest.json";\nvar ManifestConflictError = class extends Error {\n  constructor(message = "manifest etag mismatch") {\n    super(message);\n    this.name = "ManifestConflictError";\n  }\n};\nvar SALT_RE = /^[0-9a-f]{32}$/i;\nfunction isManifest(value) {\n  if (!value || typeof value !== "object") return false;\n  const v = value;\n  if (v.schema !== 1) return false;\n  if (typeof v.salt !== "string" || !SALT_RE.test(v.salt)) return false;\n  if (!Array.isArray(v.devices)) return false;\n  for (const d of v.devices) {\n    if (!d || typeof d !== "object") return false;\n    const device = d;\n    if (typeof device.id !== "string" || device.id.length === 0) return false;\n    if (typeof device.label !== "string") return false;\n    if (typeof device.pushedAt !== "string" || device.pushedAt.length === 0) return false;\n  }\n  return true;\n}\nfunction normalizeEtag(etag) {\n  return etag.trim().replace(/^W\\//, "").replace(/^"|"$/g, "");\n}\nfunction etagsMatch(a, b) {\n  return normalizeEtag(a) === normalizeEtag(b);\n}\nfunction objectEtag(obj) {\n  return obj.httpEtag || obj.etag;\n}\nasync function readManifestRecord(bucket) {\n  const obj = await bucket.get(MANIFEST_KEY);\n  if (!obj) return null;\n  const text = await obj.text();\n  let parsed;\n  try {\n    parsed = JSON.parse(text);\n  } catch {\n    throw new Error("manifest.json is not valid JSON");\n  }\n  if (!isManifest(parsed)) {\n    throw new Error("manifest.json failed schema validation");\n  }\n  return { manifest: parsed, etag: objectEtag(obj) };\n}\nasync function writeManifest(bucket, manifest, opts = {}) {\n  if (!isManifest(manifest)) {\n    throw new Error("refusing to write invalid manifest");\n  }\n  const putOpts = {\n    httpMetadata: { contentType: "application/json; charset=utf-8" }\n  };\n  if (opts.ifMatch) {\n    putOpts.onlyIf = { etagMatches: normalizeEtag(opts.ifMatch) };\n  }\n  const put = await bucket.put(MANIFEST_KEY, JSON.stringify(manifest, null, 2), putOpts);\n  if (!put) {\n    throw new ManifestConflictError();\n  }\n  return { etag: objectEtag(put) };\n}\n\n// worker/src/devices.ts\nfunction deviceObjectKey(deviceId) {\n  return `devices/${deviceId}.b64`;\n}\nfunction isValidDeviceId(deviceId) {\n  if (!deviceId || deviceId.length > 128) return false;\n  if (deviceId.includes("/") || deviceId.includes("..") || deviceId.includes("\\\\")) return false;\n  return /^[A-Za-z0-9._-]+$/.test(deviceId);\n}\nfunction parseDevicePutBody(value) {\n  if (!value || typeof value !== "object") return null;\n  const v = value;\n  if (typeof v.content !== "string" || v.content.length === 0) return null;\n  if (typeof v.label !== "string") return null;\n  if (typeof v.pushedAt !== "string" || v.pushedAt.length === 0) return null;\n  return { content: v.content, label: v.label, pushedAt: v.pushedAt };\n}\nasync function getDeviceBlob(bucket, deviceId) {\n  const obj = await bucket.get(deviceObjectKey(deviceId));\n  if (!obj) return null;\n  const content = await obj.text();\n  return { content, etag: obj.httpEtag || obj.etag };\n}\nasync function putDeviceBlob(bucket, deviceId, body, opts = {}) {\n  const current = await readManifestRecord(bucket);\n  if (!current) {\n    throw new Error("manifest.json missing \\u2014 create it before uploading devices");\n  }\n  if (opts.ifMatch && !etagsMatch(opts.ifMatch, current.etag)) {\n    throw new ManifestConflictError("If-Match does not match current manifest ETag");\n  }\n  const entry = { id: deviceId, label: body.label, pushedAt: body.pushedAt };\n  const idx = current.manifest.devices.findIndex((d) => d.id === deviceId);\n  const devices = idx >= 0 ? current.manifest.devices.map((d, i) => i === idx ? entry : d) : [...current.manifest.devices, entry];\n  const next = { ...current.manifest, devices };\n  await writeManifest(bucket, next, { ifMatch: current.etag });\n  const put = await bucket.put(deviceObjectKey(deviceId), body.content, {\n    httpMetadata: { contentType: "text/plain; charset=utf-8" }\n  });\n  return { etag: put.httpEtag || put.etag, manifest: next };\n}\nasync function deleteDeviceBlob(bucket, deviceId) {\n  await bucket.delete(deviceObjectKey(deviceId));\n  const rec = await readManifestRecord(bucket);\n  if (!rec) return null;\n  const devices = rec.manifest.devices.filter((d) => d.id !== deviceId);\n  const next = { ...rec.manifest, devices };\n  await writeManifest(bucket, next, { ifMatch: rec.etag });\n  return next;\n}\n\n// worker/src/http.ts\nfunction json(data, status = 200, extraHeaders) {\n  return new Response(JSON.stringify(data), {\n    status,\n    headers: {\n      "content-type": "application/json; charset=utf-8",\n      "cache-control": "no-store",\n      ...extraHeaders\n    }\n  });\n}\n\n// worker/src/index.ts\nvar DEVICE_PATH = /^\\/v1\\/devices\\/([^/]+)$/;\nvar index_default = {\n  async fetch(request, env, _ctx) {\n    if (request.method === "OPTIONS") {\n      return handleOptions();\n    }\n    return withCors(await handleRequest(request, env));\n  }\n};\nasync function handleRequest(request, env) {\n  const url = new URL(request.url);\n  if (request.method === "GET" && url.pathname === "/health") {\n    return json({ ok: true, version: 1 });\n  }\n  if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {\n    const denied = await requireSyncToken(request, env);\n    if (denied) return denied;\n    try {\n      if (url.pathname === "/v1/manifest" && request.method === "GET") {\n        const rec = await readManifestRecord(env.VAULT_BUCKET);\n        if (!rec) {\n          return jsonError(404, "not_found", "manifest.json does not exist yet");\n        }\n        return json(rec.manifest, 200, { ETag: rec.etag });\n      }\n      if (url.pathname === "/v1/manifest" && request.method === "PUT") {\n        let body;\n        try {\n          body = await request.json();\n        } catch {\n          return jsonError(400, "bad_request", "Request body must be JSON");\n        }\n        if (!isManifest(body)) {\n          return jsonError(400, "bad_request", "Invalid manifest schema");\n        }\n        const ifMatch = request.headers.get("If-Match");\n        const current = await readManifestRecord(env.VAULT_BUCKET);\n        if (ifMatch) {\n          if (!current || !etagsMatch(ifMatch, current.etag)) {\n            return jsonError(412, "precondition_failed", "If-Match does not match current manifest ETag");\n          }\n        }\n        try {\n          const written = await writeManifest(\n            env.VAULT_BUCKET,\n            body,\n            current ? { ifMatch: current.etag } : {}\n          );\n          return json(body, 200, { ETag: written.etag });\n        } catch (err) {\n          if (err instanceof ManifestConflictError) {\n            return jsonError(412, "precondition_failed", err.message);\n          }\n          throw err;\n        }\n      }\n      const deviceMatch = DEVICE_PATH.exec(url.pathname);\n      if (deviceMatch) {\n        const deviceId = decodeURIComponent(deviceMatch[1]);\n        if (!isValidDeviceId(deviceId)) {\n          return jsonError(400, "bad_request", "Invalid device id");\n        }\n        if (request.method === "GET") {\n          const blob = await getDeviceBlob(env.VAULT_BUCKET, deviceId);\n          if (!blob) {\n            return jsonError(404, "not_found", `Device blob not found: ${deviceId}`);\n          }\n          return json({ content: blob.content, etag: blob.etag }, 200, { ETag: blob.etag });\n        }\n        if (request.method === "PUT") {\n          let body;\n          try {\n            body = await request.json();\n          } catch {\n            return jsonError(400, "bad_request", "Request body must be JSON");\n          }\n          const parsed = parseDevicePutBody(body);\n          if (!parsed) {\n            return jsonError(400, "bad_request", "Body must be { content, label, pushedAt }");\n          }\n          try {\n            const result = await putDeviceBlob(env.VAULT_BUCKET, deviceId, parsed, {\n              ifMatch: request.headers.get("If-Match")\n            });\n            return json({\n              content: parsed.content,\n              etag: result.etag,\n              manifest: result.manifest\n            }, 200, { ETag: result.etag });\n          } catch (err) {\n            const message = err instanceof Error ? err.message : String(err);\n            if (err instanceof ManifestConflictError) {\n              return jsonError(412, "precondition_failed", message);\n            }\n            if (message.includes("manifest.json missing")) {\n              return jsonError(409, "conflict", message);\n            }\n            throw err;\n          }\n        }\n        if (request.method === "DELETE") {\n          try {\n            const manifest = await deleteDeviceBlob(env.VAULT_BUCKET, deviceId);\n            return json({ ok: true, manifest });\n          } catch (err) {\n            if (err instanceof ManifestConflictError) {\n              return jsonError(412, "precondition_failed", err.message);\n            }\n            throw err;\n          }\n        }\n      }\n      return json(\n        { error: "not_found", message: `No route for ${request.method} ${url.pathname}` },\n        404\n      );\n    } catch (err) {\n      console.error(err);\n      return jsonError(500, "internal", "Internal error");\n    }\n  }\n  return json(\n    { error: "not_found", message: `No route for ${request.method} ${url.pathname}` },\n    404\n  );\n}\nexport {\n  index_default as default\n};\n';

// src/cloudflare-deploy.ts
var CF_API = "https://api.cloudflare.com/client/v4";
var DEPLOY_TO_CLOUDFLARE_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/mrchatam/voltius-cloudflare-sync-worker";
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
async function cfCall(http, url, context, init2, tolerate) {
  const res = await send(http, url, init2);
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

// src/SettingsPage.tsx
import { jsx, jsxs } from "react/jsx-runtime";
function Btn({
  children,
  onClick,
  disabled,
  variant = "primary",
  small
}) {
  const base = "rounded-lg font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default";
  const size = small ? "px-3 py-1 text-xs" : "px-4 py-2 text-sm";
  const colors = variant === "primary" ? "bg-(--t-accent) text-white hover:bg-(--t-accent-hover)" : variant === "danger" ? "bg-transparent border border-(--t-status-error) text-(--t-status-error) hover:bg-[color-mix(in_srgb,var(--t-status-error)_10%,transparent)]" : "bg-(--t-bg-elevated) border border-(--t-border) text-(--t-text-muted) hover:border-(--t-border-hover)";
  return /* @__PURE__ */ jsx("button", { className: `${base} ${size} ${colors}`, onClick, disabled, children });
}
function Field({
  label,
  children,
  hint
}) {
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1", children: [
    /* @__PURE__ */ jsx("label", { className: "text-xs font-medium text-(--t-text-muted)", children: label }),
    children,
    hint ? /* @__PURE__ */ jsx("p", { className: "text-[11px] text-(--t-text-dim)", children: hint }) : null
  ] });
}
function textInputClass() {
  return "form-input w-full px-3 py-2 rounded-lg text-sm outline-hidden bg-(--t-bg-input) border border-(--t-border) text-(--t-text-primary)";
}
function createSettingsPage(api) {
  return function CloudflareSyncSettingsPage() {
    const [workerUrl, setWorkerUrl] = useState("");
    const [token, setToken] = useState("");
    const [passphrase, setPassphrase] = useState("");
    const [pollSeconds, setPollSeconds] = useState(60);
    const [configured, setConfigured] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null);
    const [error, setError] = useState(null);
    const [deviceCount, setDeviceCount] = useState(null);
    const [devices, setDevices] = useState([]);
    const [localDeviceId, setLocalDeviceId] = useState(null);
    const [cfAccountId, setCfAccountId] = useState("");
    const [cfApiToken, setCfApiToken] = useState("");
    const [cfWorkerName, setCfWorkerName] = useState(DEFAULT_WORKER_NAME);
    const [cfBucketName, setCfBucketName] = useState(DEFAULT_BUCKET_NAME);
    const [deployBusy, setDeployBusy] = useState(false);
    const refresh = useCallback(async () => {
      const [url, tok, cfg] = await Promise.all([
        api.storage.get("workerUrl"),
        api.vault.get("syncToken"),
        isConfigured()
      ]);
      setConfigured(cfg);
      const localId = await getDeviceId();
      setLocalDeviceId(localId);
      if (cfg && url && tok) {
        try {
          const manifest = await getManifest(api.http, url, tok);
          setDeviceCount(manifest.devices.length);
          setDevices(manifest.devices);
        } catch {
          setDeviceCount(null);
          setDevices([]);
        }
      } else {
        setDeviceCount(null);
        setDevices([]);
      }
    }, [api]);
    useEffect(() => {
      void (async () => {
        const [url, tok, pass, poll, accountId, workerName, bucketName] = await Promise.all([
          api.storage.get("workerUrl"),
          api.vault.get("syncToken"),
          api.vault.get("passphrase"),
          api.storage.get("pollIntervalSeconds"),
          api.storage.get("cfAccountId"),
          api.storage.get("cfWorkerName"),
          api.storage.get("cfBucketName")
        ]);
        setWorkerUrl(url ?? "");
        setToken(tok ?? "");
        setPassphrase(pass ?? "");
        setPollSeconds(poll ?? 60);
        setCfAccountId(accountId ?? "");
        setCfWorkerName(workerName || DEFAULT_WORKER_NAME);
        setCfBucketName(bucketName || DEFAULT_BUCKET_NAME);
      })();
      void refresh();
    }, [refresh]);
    async function run(action, okMsg) {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        await action();
        setMessage(okMsg);
        await refresh();
      } catch (err) {
        const msg = err instanceof WorkerApiError || err instanceof CloudflareDeployError ? err.message : err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setBusy(false);
      }
    }
    const syncState = getCloudflareSyncState();
    return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-6 p-4 max-w-xl", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex items-start gap-3", children: [
        /* @__PURE__ */ jsx(Icon, { icon: "lucide:cloud", width: 22, className: "text-(--t-text-primary) mt-0.5" }),
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("h2", { className: "text-lg font-semibold text-(--t-text-primary)", children: api.i18n.t("settingsLabel") }),
          /* @__PURE__ */ jsxs("p", { className: "text-sm text-(--t-text-muted)", children: [
            "Sync encrypted vault blobs to your own Cloudflare Worker + R2. The Worker only sees ciphertext. Use a passphrase that is",
            " ",
            /* @__PURE__ */ jsx("strong", { className: "font-medium", children: "not" }),
            " your sync token."
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-2 rounded-lg border border-(--t-border) bg-(--t-bg-elevated) px-3 py-3", children: [
        /* @__PURE__ */ jsx("h3", { className: "text-sm font-semibold text-(--t-text-primary)", children: "Why Cloudflare Sync instead of Gist?" }),
        /* @__PURE__ */ jsx("p", { className: "text-[11px] text-(--t-text-dim)", children: "Gist Sync is great when you already live on GitHub. Prefer this when you want your own cloud:" }),
        /* @__PURE__ */ jsxs("ul", { className: "list-disc pl-4 text-sm text-(--t-text-muted) space-y-1", children: [
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx("strong", { className: "font-medium text-(--t-text-primary)", children: "You own the store" }),
            " \u2014 ciphertext lives in your R2 bucket, not on GitHub Gists."
          ] }),
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx("strong", { className: "font-medium text-(--t-text-primary)", children: "No GitHub PAT" }),
            " \u2014 no gist scopes or GitHub account required for sync."
          ] }),
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx("strong", { className: "font-medium text-(--t-text-primary)", children: "Built for objects" }),
            " \u2014 R2 is object storage (limits suited to vault blobs), not a gist file API."
          ] }),
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx("strong", { className: "font-medium text-(--t-text-primary)", children: "Deploy from Voltius" }),
            " \u2014 create Worker + bucket + sync token from Settings without leaving the app."
          ] }),
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx("strong", { className: "font-medium text-(--t-text-primary)", children: "Same E2EE model" }),
            " \u2014 passphrase stays on-device; Worker sees ciphertext only (like Gist Sync)."
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-3", children: [
        /* @__PURE__ */ jsx("h3", { className: "text-sm font-semibold text-(--t-text-primary)", children: "Deploy Worker" }),
        /* @__PURE__ */ jsx("p", { className: "text-xs text-(--t-text-dim)", children: "Deploy the sync Worker into your Cloudflare account from here (no Wrangler required). API token stays in memory only. After deploy, use Create vault / Link below \u2014 deploy alone does not mark the vault configured." }),
        /* @__PURE__ */ jsx(
          Field,
          {
            label: "Cloudflare Account ID",
            hint: "Dashboard \u2192 Workers & Pages \u2192 Account ID (right sidebar)",
            children: /* @__PURE__ */ jsx(
              "input",
              {
                className: textInputClass(),
                value: cfAccountId,
                onChange: (e) => {
                  setCfAccountId(e.target.value);
                  void api.storage.set("cfAccountId", e.target.value.trim());
                },
                placeholder: "32-char hex account id",
                autoComplete: "off"
              }
            )
          }
        ),
        /* @__PURE__ */ jsx(
          Field,
          {
            label: "Cloudflare API token",
            hint: "Permissions: Workers Scripts Edit, Workers R2 Storage Edit, Account Settings Read. Not saved.",
            children: /* @__PURE__ */ jsx(
              "input",
              {
                type: "password",
                className: textInputClass(),
                value: cfApiToken,
                onChange: (e) => setCfApiToken(e.target.value),
                placeholder: "API token (kept in memory only)",
                autoComplete: "off"
              }
            )
          }
        ),
        /* @__PURE__ */ jsx(Field, { label: "Worker name", hint: `Default: ${DEFAULT_WORKER_NAME}`, children: /* @__PURE__ */ jsx(
          "input",
          {
            className: textInputClass(),
            value: cfWorkerName,
            onChange: (e) => {
              setCfWorkerName(e.target.value);
              void api.storage.set("cfWorkerName", e.target.value.trim() || DEFAULT_WORKER_NAME);
            },
            placeholder: DEFAULT_WORKER_NAME
          }
        ) }),
        /* @__PURE__ */ jsx(Field, { label: "R2 bucket name", hint: `Default: ${DEFAULT_BUCKET_NAME} (created if missing)`, children: /* @__PURE__ */ jsx(
          "input",
          {
            className: textInputClass(),
            value: cfBucketName,
            onChange: (e) => {
              setCfBucketName(e.target.value);
              void api.storage.set("cfBucketName", e.target.value.trim() || DEFAULT_BUCKET_NAME);
            },
            placeholder: DEFAULT_BUCKET_NAME
          }
        ) }),
        /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-2", children: [
          /* @__PURE__ */ jsx(
            Btn,
            {
              variant: "secondary",
              disabled: busy || deployBusy,
              onClick: () => {
                setToken(generateSyncToken());
                api.notifications.toast("Generated sync token (saved when you create or link a vault)", {
                  severity: "success"
                });
              },
              children: "Generate sync token"
            }
          ),
          /* @__PURE__ */ jsx(
            Btn,
            {
              disabled: busy || deployBusy || !cfAccountId.trim() || !cfApiToken.trim() || !token.trim(),
              onClick: () => void (async () => {
                setDeployBusy(true);
                setError(null);
                setMessage(null);
                try {
                  const result = await deployWorker(api.http, {
                    accountId: cfAccountId,
                    apiToken: cfApiToken,
                    workerName: cfWorkerName,
                    bucketName: cfBucketName,
                    syncToken: token
                  });
                  if (result.workerUrl) {
                    setWorkerUrl(result.workerUrl);
                    setMessage(
                      `Worker deployed: ${result.workerUrl}. Enter a passphrase, then Create vault or Link existing.`
                    );
                    api.notifications.toast("Worker deployed", { severity: "success" });
                  } else {
                    setMessage(
                      "Worker script and SYNC_TOKEN deployed, but workers.dev subdomain could not be resolved (need Account Settings Read). Paste the Worker URL from the Cloudflare dashboard into Worker URL below."
                    );
                    api.notifications.toast("Deployed \u2014 paste Worker URL manually", {
                      severity: "warning"
                    });
                  }
                } catch (err) {
                  const msg = err instanceof CloudflareDeployError || err instanceof Error ? err.message : String(err);
                  setError(msg);
                  api.notifications.toast("Deploy failed", { severity: "error" });
                } finally {
                  setDeployBusy(false);
                }
              })(),
              children: deployBusy ? "Deploying\u2026" : "Deploy Worker"
            }
          ),
          /* @__PURE__ */ jsx(
            Btn,
            {
              variant: "secondary",
              disabled: busy || deployBusy,
              onClick: () => void (async () => {
                try {
                  await navigator.clipboard.writeText(DEPLOY_TO_CLOUDFLARE_URL);
                  api.notifications.toast("Deploy-to-Cloudflare URL copied", { severity: "success" });
                } catch {
                  setMessage(`Copy this URL: ${DEPLOY_TO_CLOUDFLARE_URL}`);
                  api.notifications.toast("Could not access clipboard \u2014 URL shown below", {
                    severity: "info"
                  });
                }
              })(),
              children: "Copy Deploy-to-Cloudflare URL"
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-3", children: [
        /* @__PURE__ */ jsx("h3", { className: "text-sm font-semibold text-(--t-text-primary)", children: "Connection" }),
        /* @__PURE__ */ jsx("p", { className: "text-xs text-(--t-text-dim)", children: "These values are saved only when Create vault or Link existing succeeds." }),
        /* @__PURE__ */ jsx(Field, { label: "Worker URL", hint: "Example: https://voltius-sync.example.workers.dev", children: /* @__PURE__ */ jsx(
          "input",
          {
            className: textInputClass(),
            value: workerUrl,
            onChange: (e) => setWorkerUrl(e.target.value),
            placeholder: "https://your-worker.workers.dev"
          }
        ) }),
        /* @__PURE__ */ jsx(Field, { label: "Sync token", hint: "Bearer token configured as SYNC_TOKEN on the Worker", children: /* @__PURE__ */ jsx(
          "input",
          {
            type: "password",
            className: textInputClass(),
            value: token,
            onChange: (e) => setToken(e.target.value),
            placeholder: "Long random secret"
          }
        ) }),
        /* @__PURE__ */ jsx(
          Field,
          {
            label: "Encryption passphrase",
            hint: "Required. Derives the vault encryption key. Never reuse the sync token.",
            children: /* @__PURE__ */ jsx(
              "input",
              {
                type: "password",
                className: textInputClass(),
                value: passphrase,
                onChange: (e) => setPassphrase(e.target.value),
                placeholder: "Strong passphrase"
              }
            )
          }
        ),
        /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-2", children: [
          /* @__PURE__ */ jsx(
            Btn,
            {
              disabled: busy || !workerUrl || !token || !passphrase,
              onClick: () => void run(async () => {
                try {
                  await setupNewVault(workerUrl, token, passphrase);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  if (!msg.includes("already exists")) throw err;
                  const ok = window.confirm(
                    "A remote vault already exists on this Worker. Overwrite it? This replaces the remote salt/manifest and can make old device blobs undecryptable with a new passphrase."
                  );
                  if (!ok) throw new Error("Create vault cancelled");
                  await setupNewVault(workerUrl, token, passphrase, { overwrite: true });
                }
                const interval = await api.storage.get("pollIntervalSeconds") ?? pollSeconds ?? 60;
                stopPoll();
                startPoll(interval);
                await syncNow({ showProgress: false });
              }, "Created remote vault and uploaded this device"),
              children: "Create vault"
            }
          ),
          /* @__PURE__ */ jsx(
            Btn,
            {
              variant: "secondary",
              disabled: busy || !workerUrl || !token || !passphrase,
              onClick: () => void run(async () => {
                await linkExistingVault(workerUrl, token, passphrase);
                const interval = await api.storage.get("pollIntervalSeconds") ?? pollSeconds ?? 60;
                stopPoll();
                startPoll(interval);
                await syncNow({ showProgress: true });
              }, "Linked existing vault"),
              children: "Link existing"
            }
          ),
          /* @__PURE__ */ jsx(
            Btn,
            {
              variant: "secondary",
              disabled: busy || !workerUrl,
              onClick: () => void run(async () => {
                const health = await getHealth(api.http, workerUrl);
                if (!health.ok) throw new Error("Worker health check failed");
              }, "Worker health OK"),
              children: "Test health"
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-3", children: [
        /* @__PURE__ */ jsx("h3", { className: "text-sm font-semibold text-(--t-text-primary)", children: "Sync" }),
        /* @__PURE__ */ jsxs("div", { className: "text-sm text-(--t-text-muted)", children: [
          "Status: ",
          /* @__PURE__ */ jsx("span", { className: "text-(--t-text-primary)", children: syncState.status }),
          configured ? " \xB7 configured" : " \xB7 not configured",
          deviceCount != null ? ` \xB7 ${deviceCount} device(s)` : "",
          syncState.lastSync ? ` \xB7 last ${syncState.lastSync.toLocaleString()}` : ""
        ] }),
        /* @__PURE__ */ jsx(Field, { label: "Poll interval (seconds)", children: /* @__PURE__ */ jsx(
          "input",
          {
            type: "number",
            min: 10,
            max: 3600,
            className: textInputClass(),
            value: pollSeconds,
            onChange: (e) => setPollSeconds(Number(e.target.value) || 60),
            onBlur: () => {
              const clamped = Math.min(3600, Math.max(10, pollSeconds || 60));
              setPollSeconds(clamped);
              void api.storage.set("pollIntervalSeconds", clamped).then(() => {
                if (configured) {
                  stopPoll();
                  startPoll(clamped);
                }
              });
            }
          }
        ) }),
        /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-2", children: [
          /* @__PURE__ */ jsx(
            Btn,
            {
              disabled: busy || !configured,
              onClick: () => void run(() => syncNow({ showProgress: true }), "Sync finished"),
              children: "Sync now"
            }
          ),
          /* @__PURE__ */ jsx(
            Btn,
            {
              variant: "danger",
              disabled: busy || !configured,
              onClick: () => void run(() => disconnect(), "Disconnected"),
              children: "Disconnect"
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-3", children: [
        /* @__PURE__ */ jsx("h3", { className: "text-sm font-semibold text-(--t-text-primary)", children: "Remote devices" }),
        devices.length === 0 ? /* @__PURE__ */ jsx("p", { className: "text-sm text-(--t-text-dim)", children: "No devices listed yet." }) : /* @__PURE__ */ jsx("ul", { className: "flex flex-col gap-2", children: devices.map((d) => /* @__PURE__ */ jsxs(
          "li",
          {
            className: "flex items-center justify-between gap-2 rounded-lg border border-(--t-border) px-3 py-2 text-sm",
            children: [
              /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
                /* @__PURE__ */ jsxs("div", { className: "text-(--t-text-primary) truncate", children: [
                  d.label || d.id,
                  d.id === localDeviceId ? " (this device)" : ""
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "text-[11px] text-(--t-text-dim) truncate", children: [
                  d.id,
                  " \xB7 ",
                  d.pushedAt
                ] })
              ] }),
              d.id !== localDeviceId ? /* @__PURE__ */ jsx(
                Btn,
                {
                  small: true,
                  variant: "danger",
                  disabled: busy,
                  onClick: () => void run(
                    () => removeRemoteDevice(d.id),
                    `Removed device ${d.label || d.id}`
                  ),
                  children: "Remove"
                }
              ) : null
            ]
          },
          d.id
        )) })
      ] }),
      message ? /* @__PURE__ */ jsx("p", { className: "text-sm text-(--t-status-connected)", children: message }) : null,
      error ? /* @__PURE__ */ jsx("p", { className: "text-sm text-(--t-status-error)", children: error }) : null,
      /* @__PURE__ */ jsxs("p", { className: "text-[11px] text-(--t-text-dim)", children: [
        /* @__PURE__ */ jsx("strong", { className: "font-medium", children: "Deploy Worker" }),
        " uploads the Worker bundled with this plugin (source: VoltiusApp/marketplace, cloudflare-sync/worker). The Deploy-to-Cloudflare URL deploys the upstream mrchatam/voltius-cloudflare-sync-worker repository instead."
      ] })
    ] });
  };
}

// src/index.tsx
function register(api) {
  api.i18n.register(messages);
  init(api);
  api.ui.registerSettingsPage({
    id: "cloudflare-sync-settings",
    label: () => api.i18n.t("settingsLabel"),
    icon: "lucide:cloud",
    component: createSettingsPage(api)
  });
  api.plugins.expose({ syncNow });
  let offBeforeQuit = null;
  if (api.isActive()) {
    void (async () => {
      if (!await isConfigured()) return;
      await syncNow();
      const interval = await api.storage.get("pollIntervalSeconds") ?? 60;
      startPoll(interval);
    })();
    offBeforeQuit = api.lifecycle.onBeforeQuit(async () => {
      if (await isConfigured()) await push().catch(() => {
      });
    });
  }
  return () => {
    stopPoll();
    offBeforeQuit?.();
  };
}
export {
  register as default
};
