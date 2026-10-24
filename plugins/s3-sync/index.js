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
var DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

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

// src/config.ts
var STORAGE_KEYS = ["s3Endpoint", "s3Region", "s3Bucket", "s3Prefix", "s3Addressing"];
var VAULT_KEYS = ["s3AccessKeyId", "s3SecretAccessKey"];
var PRIVATE_SUFFIXES = [".local", ".lan", ".home.arpa", ".internal"];
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h.includes(":")) return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  if (h === "localhost" || !h.includes(".") || PRIVATE_SUFFIXES.some((s) => h.endsWith(s))) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254;
}
function normalizeEndpoint(raw) {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("s3-sync: the endpoint is required");
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("s3-sync: the endpoint is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("s3-sync: the endpoint must start with https://");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("s3-sync: the endpoint must not contain a path \u2014 put the bucket in the Bucket field");
  }
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    throw new Error("s3-sync: the endpoint must use https:// (http:// only for localhost or a private network address)");
  }
  return `${url.protocol}//${url.host}`;
}
function normalizePrefix(raw) {
  const p = raw.trim().replace(/^\/+|\/+$/g, "");
  if (!p) return "";
  if (p.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new Error('s3-sync: the prefix cannot contain a "." or ".." segment');
  }
  return `${p}/`;
}
function displayPrefix(prefix) {
  return prefix.trim().replace(/^\/+|\/+$/g, "");
}
var BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
function validateBucket({ bucket, addressing, endpoint }) {
  if (!BUCKET_RE.test(bucket)) {
    throw new Error("s3-sync: bucket names are 3\u201363 lowercase letters, digits, dots or hyphens");
  }
  if (addressing === "virtual" && bucket.includes(".") && /^https:/i.test(endpoint.trim())) {
    throw new Error(
      "s3-sync: a bucket name with dots does not work over https:// in virtual-hosted style \u2014 untick the hostname option or use a bucket without dots"
    );
  }
}
async function loadS3Config(api) {
  const [endpoint, region, bucket, prefix, addressing] = await Promise.all(
    STORAGE_KEYS.map((k) => api.storage.get(k))
  );
  const [accessKeyId, secretAccessKey] = await Promise.all(VAULT_KEYS.map((k) => api.vault.get(k)));
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    region: region ?? "",
    bucket,
    prefix: prefix ?? "",
    addressing: addressing === "virtual" ? "virtual" : "path",
    accessKeyId,
    secretAccessKey
  };
}
function toConfigValues(cfg) {
  return {
    storage: {
      s3Endpoint: cfg.endpoint,
      s3Region: cfg.region,
      s3Bucket: cfg.bucket,
      s3Prefix: cfg.prefix,
      s3Addressing: cfg.addressing
    },
    vault: { s3AccessKeyId: cfg.accessKeyId, s3SecretAccessKey: cfg.secretAccessKey }
  };
}

// ../shared/vault-sync/src/http.ts
var REQUEST_TIMEOUT_MS = 6e4;
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

// src/md5.ts
var S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
var K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
function md5(input) {
  const data = new TextEncoder().encode(input);
  const padded = new Uint8Array((data.length + 8 >> 6) + 1 << 6);
  padded.set(data);
  padded[data.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, data.length * 8 >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(data.length / 2 ** 29), true);
  const state = [1732584193, 4023233417, 2562383102, 271733878];
  for (let off = 0; off < padded.length; off += 64) {
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) [f, g] = [b & c | ~b & d, i];
      else if (i < 32) [f, g] = [d & b | ~d & c, (5 * i + 1) % 16];
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), 7 * i % 16];
      const s = S[i >> 4 << 2 | i & 3];
      const sum = a + f + K[i] + view.getUint32(off + g * 4, true) | 0;
      [a, d, c] = [d, c, b];
      b = b + (sum << s | sum >>> 32 - s) | 0;
    }
    [a, b, c, d].forEach((v, j) => state[j] = state[j] + v | 0);
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  state.forEach((w, i) => outView.setUint32(i * 4, w >>> 0, true));
  return out;
}
function md5Base64(input) {
  return btoa(String.fromCharCode(...md5(input)));
}

// src/s3-xml.ts
var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
var ESCAPES = Object.fromEntries(Object.entries(ENTITIES).map(([name, ch]) => [ch, `&${name};`]));
function escapeXml(s) {
  return s.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}
function decodeXml(s) {
  return s.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()]
  );
}
function tag(xml, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1]) : null;
}
function parseListObjects(xml) {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, c]) => ({
    key: tag(c, "Key") ?? "",
    etag: (tag(c, "ETag") ?? "").replace(/^"|"$/g, ""),
    lastModified: tag(c, "LastModified") ?? "",
    size: tag(c, "Size") ?? ""
  }));
  return { objects, truncated: tag(xml, "IsTruncated") === "true", nextToken: tag(xml, "NextContinuationToken") };
}
function parseErrorBody(body) {
  const xml = body.replace(/^HTTP \d{3}: /, "");
  return { code: tag(xml, "Code"), message: tag(xml, "Message") };
}
function deleteErrors(xml) {
  return [...xml.matchAll(/<Error>[\s\S]*?<\/Error>/g)].map(([e]) => e);
}

// src/s3-errors.ts
var AUTH_CODES = /* @__PURE__ */ new Set(["InvalidAccessKeyId", "SignatureDoesNotMatch", "AccessDenied", "AllAccessDisabled", "AccountProblem"]);
var WRONG_REGION_CODES = /* @__PURE__ */ new Set(["AuthorizationHeaderMalformed", "PermanentRedirect"]);
function toStoreError(status, body) {
  const { code, message } = parseErrorBody(body);
  if (code === "RequestTimeTooSkewed") {
    return new StoreError("clock", "This device's clock is off, so the storage provider rejected the request. Fix the system time and try again.", status);
  }
  if (status === 401 || code !== null && AUTH_CODES.has(code) || status === 403 && code === null) {
    return new StoreError("auth", "The storage provider rejected the access key or secret, or the key cannot access this bucket.", status);
  }
  if (code === "NoSuchBucket") {
    return new StoreError("not_found", "Bucket not found \u2014 check the bucket name, region and endpoint.", status);
  }
  if (code !== null && WRONG_REGION_CODES.has(code)) {
    return new StoreError("not_found", "This bucket lives in another region or behind another endpoint \u2014 check the region and endpoint.", status);
  }
  if (status === 412 || status === 409) return new StoreError("conflict", "The object changed while writing it", status);
  return new StoreError("other", code ? `${code}: ${message ?? `HTTP ${status}`}` : `HTTP ${status}`, status);
}

// src/sigv4.ts
var encoder = new TextEncoder();
function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(data) {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}
function encodeRfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function encodeKeyPath(key) {
  return key.split("/").map(encodeRfc3986).join("/");
}
function canonicalQuery(query) {
  return query.map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)]).sort(([ak, av], [bk, bv]) => ak === bk ? av < bv ? -1 : av > bv ? 1 : 0 : ak < bk ? -1 : 1).map(([k, v]) => `${k}=${v}`).join("&");
}
function amzDate(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
async function signRequest(input) {
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const payloadHash = await sha256Hex(input.body);
  const headers = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v;
  headers["x-amz-content-sha256"] = payloadHash;
  headers["x-amz-date"] = date;
  const signed = { ...headers, host: input.host };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n].trim().replace(/\s+/g, " ")}
`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, await sha256Hex(canonicalRequest)].join("\n");
  let key = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), day);
  for (const part of [input.region, "s3", "aws4_request"]) key = await hmac(key, part);
  const signature = toHex(await hmac(key, stringToSign));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return headers;
}

// src/s3-store.ts
var VAULT_KEY = "vault.json";
var PROBE_KEY = ".voltius-probe";
var DEVICES_DIR = "devices/";
var SALT_RE = /^[0-9a-f]{32}$/i;
var S3Store = class {
  constructor(http, cfg, now = () => /* @__PURE__ */ new Date()) {
    this.http = http;
    this.cfg = cfg;
    this.now = now;
    validateBucket(cfg);
    this.endpoint = new URL(normalizeEndpoint(cfg.endpoint));
    this.prefix = normalizePrefix(cfg.prefix);
  }
  endpoint;
  prefix;
  target(key) {
    const encoded = key === null ? "" : encodeKeyPath(key);
    if (this.cfg.addressing === "virtual") {
      return { host: `${this.cfg.bucket}.${this.endpoint.host}`, path: `/${encoded}` };
    }
    return { host: this.endpoint.host, path: `/${encodeRfc3986(this.cfg.bucket)}${key === null ? "" : `/${encoded}`}` };
  }
  async request(method, key, opts = {}) {
    const { host, path } = this.target(key);
    const query = opts.query ?? [];
    const body = opts.body ?? "";
    const headers = await signRequest({
      method,
      host,
      path,
      query,
      headers: opts.headers ?? {},
      body,
      region: this.cfg.region.trim() || "us-east-1",
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      now: this.now()
    });
    const qs = canonicalQuery(query);
    return send(this.http, `${this.endpoint.protocol}//${host}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers,
      body: method === "GET" ? void 0 : body
    });
  }
  key(name) {
    return `${this.prefix}${name}`;
  }
  isMissingObject(res) {
    return res.status === 404 && parseErrorBody(res.body).code !== "NoSuchBucket";
  }
  async getText(name) {
    const res = await this.request("GET", this.key(name));
    if (res.ok) return res.body;
    if (this.isMissingObject(res)) return null;
    throw toStoreError(res.status, res.body);
  }
  async putText(name, body, contentType, headers = {}) {
    const res = await this.request("PUT", this.key(name), { body, headers: { "content-type": contentType, ...headers } });
    if (!res.ok) throw toStoreError(res.status, res.body);
  }
  // Single-object DELETE answers 204, which released hosts' HTTP bridge cannot deliver.
  async deleteKeys(names) {
    const objects = names.map((n) => `<Object><Key>${escapeXml(this.key(n))}</Key></Object>`).join("");
    const body = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${objects}</Delete>`;
    const res = await this.request("POST", null, {
      query: [["delete", ""]],
      body,
      headers: { "content-md5": md5Base64(body), "content-type": "application/xml" }
    });
    if (!res.ok) throw toStoreError(res.status, res.body);
    const [failed] = deleteErrors(res.body);
    if (failed) throw toStoreError(res.status, failed);
  }
  async readSalt() {
    const text = await this.getText(VAULT_KEY);
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed.schema === 1 && typeof parsed.salt === "string" && SALT_RE.test(parsed.salt)) return parsed.salt;
    } catch {
    }
    throw new StoreError("other", `${this.key(VAULT_KEY)} in this bucket is not a Voltius vault`);
  }
  async createSalt(salt) {
    const body = JSON.stringify({ schema: 1, salt });
    try {
      await this.putText(VAULT_KEY, body, "application/json", { "if-none-match": "*" });
    } catch (err) {
      if (!(err instanceof StoreError && (err.kind === "conflict" || err.kind === "other"))) throw err;
      const existing = await this.readSalt().catch(() => {
        throw err;
      });
      if (existing) return existing;
      const conditionalRejected = err.kind === "other" && (err.status === 400 || err.status === 501);
      if (!conditionalRejected) throw err;
      await this.putText(VAULT_KEY, body, "application/json");
    }
    const stored = await this.readSalt();
    if (stored) return stored;
    throw new StoreError("other", "The vault file could not be read back after writing it");
  }
  async listDevices() {
    const dir = this.key(DEVICES_DIR);
    const out = [];
    let token = null;
    do {
      const query = [["list-type", "2"], ["prefix", dir]];
      if (token) query.push(["continuation-token", token]);
      const res = await this.request("GET", null, { query });
      if (!res.ok) throw toStoreError(res.status, res.body);
      const page = parseListObjects(res.body);
      for (const o of page.objects) {
        const rest = o.key.slice(dir.length);
        if (!o.key.startsWith(dir) || !rest.endsWith(".b64")) continue;
        const id = rest.slice(0, -4);
        if (DEVICE_ID_RE.test(id)) out.push({ id, version: o.etag || `${o.lastModified}:${o.size}` });
      }
      token = page.truncated ? page.nextToken : null;
    } while (token);
    return out;
  }
  async describeDevices() {
    const devices = await this.listDevices();
    return Promise.all(
      devices.map(async ({ id }) => {
        try {
          const text = await this.getText(this.deviceFile(id, "json"));
          const meta = JSON.parse(text ?? "");
          return {
            id,
            label: typeof meta.label === "string" && meta.label ? meta.label : id,
            pushedAt: typeof meta.pushedAt === "string" ? meta.pushedAt : ""
          };
        } catch {
          return { id, label: id, pushedAt: "" };
        }
      })
    );
  }
  deviceFile(id, ext) {
    if (!DEVICE_ID_RE.test(id)) throw new StoreError("other", `"${id}" is not a valid device id`);
    return `${DEVICES_DIR}${id}.${ext}`;
  }
  async getDevice(id) {
    return this.getText(this.deviceFile(id, "b64"));
  }
  async putDevice(id, blob, info) {
    await this.putText(this.deviceFile(id, "b64"), blob, "text/plain; charset=utf-8");
    await this.putText(this.deviceFile(id, "json"), JSON.stringify(info), "application/json");
  }
  async deleteDevice(id) {
    await this.deleteKeys([this.deviceFile(id, "b64"), this.deviceFile(id, "json")]);
  }
  async probe() {
    const step = async (label, fn) => {
      try {
        await fn();
      } catch (err) {
        const message = `${label} test failed: ${err instanceof Error ? err.message : String(err)}`;
        throw err instanceof StoreError ? new StoreError(err.kind, message, err.status) : new Error(message);
      }
    };
    await step("Write", () => this.putText(PROBE_KEY, "ok", "text/plain; charset=utf-8"));
    await step("Read", async () => {
      if (await this.getText(PROBE_KEY) !== "ok") throw new Error("the bucket did not return what was written");
    });
    await step("Delete", () => this.deleteKeys([PROBE_KEY]));
  }
};

// src/engine.ts
function createS3Engine(api) {
  return createVaultSyncEngine({
    api,
    storageKeys: STORAGE_KEYS,
    vaultKeys: VAULT_KEYS,
    openStore: async () => {
      const cfg = await loadS3Config(api);
      return cfg ? new S3Store(api.http, cfg) : null;
    }
  });
}

// src/i18n.ts
var messages = {
  en: { settingsLabel: "S3 Sync" },
  fr: { settingsLabel: "Synchronisation S3" },
  ru: { settingsLabel: "\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u044F S3" },
  zh: { settingsLabel: "S3 \u540C\u6B65" }
};

// src/SettingsPage.tsx
import { useEffect as useEffect2, useState as useState5 } from "react";

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
function ConnectionRow({ label, value }) {
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1", children: [
    /* @__PURE__ */ jsx("span", { className: "text-xs font-medium text-(--t-text-muted)", children: label }),
    /* @__PURE__ */ jsx("span", { className: "text-sm font-mono text-(--t-text-primary) break-all", children: value })
  ] });
}
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

// src/SetupWizard.tsx
import { useState as useState4 } from "react";
import { FormSelect } from "@voltius/ui";

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

// src/presets.ts
var PRESETS = [
  { id: "aws", name: "AWS S3", endpoint: "https://s3.{region}.amazonaws.com", region: "us-east-1", regionHint: "e.g. eu-west-3", addressing: "virtual", keysUrl: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html" },
  { id: "r2", name: "Cloudflare R2", endpoint: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com", region: "auto", regionHint: "auto", endpointHint: "Replace <ACCOUNT_ID> with your Cloudflare account ID (Cloudflare dashboard \u203A R2 \u203A API).", addressing: "path", keysUrl: "https://developers.cloudflare.com/r2/api/tokens/" },
  { id: "b2", name: "Backblaze B2", endpoint: "https://s3.{region}.backblazeb2.com", region: "us-west-004", regionHint: "shown on the bucket page, e.g. eu-central-003", addressing: "path", keysUrl: "https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys" },
  { id: "wasabi", name: "Wasabi", endpoint: "https://s3.{region}.wasabisys.com", region: "us-east-1", regionHint: "e.g. eu-central-1", addressing: "path", keysUrl: "https://docs.wasabi.com/docs/creating-a-user-account-and-access-key" },
  { id: "minio", name: "MinIO", endpoint: "http://localhost:9000", region: "us-east-1", regionHint: "usually us-east-1", addressing: "path", keysUrl: "https://min.io/docs/minio/linux/administration/identity-access-management/minio-user-management.html" },
  { id: "hetzner", name: "Hetzner", endpoint: "https://{region}.your-objectstorage.com", region: "fsn1", regionHint: "fsn1, nbg1 or hel1", addressing: "virtual", keysUrl: "https://docs.hetzner.com/storage/object-storage/getting-started/generating-s3-keys/" },
  { id: "scaleway", name: "Scaleway", endpoint: "https://s3.{region}.scw.cloud", region: "fr-par", regionHint: "fr-par, nl-ams or pl-waw", addressing: "path", keysUrl: "https://www.scaleway.com/en/docs/iam/how-to/create-api-keys/" },
  { id: "other", name: "Other", endpoint: "", region: "", regionHint: "leave empty for us-east-1", addressing: "path", keysUrl: null }
];
function endpointFor(preset, region) {
  return preset.endpoint.replace("{region}", region.trim() || preset.region);
}
function endpointAfterRegionChange(preset, endpoint, previousRegion, region) {
  if (!preset?.endpoint.includes("{region}") || endpoint !== endpointFor(preset, previousRegion)) return endpoint;
  return endpointFor(preset, region);
}

// src/SetupWizard.tsx
import { Fragment as Fragment2, jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function SetupWizard({ api, engine, onDone }) {
  const [preset, setPreset] = useState4(null);
  const [connection, setConnection] = useState4(null);
  const [summary, setSummary] = useState4("");
  const { busy, error, setError, run } = useAction();
  const [endpoint, setEndpoint] = useState4("");
  const [region, setRegion] = useState4("");
  const [bucket, setBucket] = useState4("");
  const [prefix, setPrefix] = useState4("voltius");
  const [addressing, setAddressing] = useState4("path");
  const [accessKeyId, setAccessKeyId] = useState4("");
  const [secretAccessKey, setSecretAccessKey] = useState4("");
  const choosePreset = (p) => {
    setPreset(p);
    setRegion(p.region);
    setEndpoint(endpointFor(p, p.region));
    setAddressing(p.addressing);
  };
  const changeRegion = (value) => {
    setEndpoint(endpointAfterRegionChange(preset, endpoint, region, value));
    setRegion(value);
  };
  const connect = () => run("Testing the bucket\u2026", async () => {
    validateBucket({ bucket: bucket.trim(), addressing, endpoint });
    const cfg = {
      endpoint: normalizeEndpoint(endpoint),
      region: region.trim(),
      bucket: bucket.trim(),
      prefix: normalizePrefix(prefix),
      addressing,
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secretAccessKey.trim()
    };
    const store = new S3Store(api.http, cfg);
    await store.probe();
    const vault = await engine.detectVault(store);
    setSummary(`${cfg.endpoint} \xB7 ${cfg.bucket}${cfg.prefix ? `/${displayPrefix(cfg.prefix)}` : ""}`);
    setConnection({ store, vault, values: toConfigValues(cfg) });
  });
  const connectReason = !endpoint.trim() ? "Enter the endpoint" : !bucket.trim() ? "Enter the bucket name" : !accessKeyId.trim() || !secretAccessKey.trim() ? "Enter the access key and secret" : null;
  return /* @__PURE__ */ jsxs4("div", { className: "flex flex-col gap-3", children: [
    error && /* @__PURE__ */ jsx4(ErrorBanner, { message: error }),
    /* @__PURE__ */ jsxs4(
      StepCard,
      {
        n: 1,
        title: "Which storage provider?",
        state: preset ? "done" : "active",
        summary: preset?.name,
        onChange: busy ? void 0 : () => {
          setPreset(null);
          setConnection(null);
          setError(null);
        },
        children: [
          /* @__PURE__ */ jsx4(
            FormSelect,
            {
              ariaLabel: "Storage provider",
              value: "",
              options: [{ value: "", label: "Choose a provider" }, ...PRESETS.map((p) => ({ value: p.id, label: p.name }))],
              onChange: (id) => {
                const p = PRESETS.find((x) => x.id === id);
                if (p) choosePreset(p);
              }
            }
          ),
          /* @__PURE__ */ jsx4(Hint, { children: "Any S3-compatible service works. Pick Other if yours is not listed." })
        ]
      }
    ),
    /* @__PURE__ */ jsxs4(
      StepCard,
      {
        n: 2,
        title: "Connect to your bucket",
        state: !preset ? "locked" : connection ? "done" : "active",
        summary: /* @__PURE__ */ jsx4("span", { className: "font-mono", children: summary }),
        onChange: busy ? void 0 : () => {
          setConnection(null);
          setError(null);
        },
        children: [
          /* @__PURE__ */ jsx4(TextInput, { label: "Endpoint", value: endpoint, onChange: setEndpoint, placeholder: "https://s3.example.com", hint: preset?.endpointHint }),
          /* @__PURE__ */ jsx4(TextInput, { label: "Region", value: region, onChange: changeRegion, hint: preset?.regionHint }),
          /* @__PURE__ */ jsx4(TextInput, { label: "Bucket", value: bucket, onChange: setBucket, placeholder: "voltius-vault", hint: "Create the bucket first, in your provider's console." }),
          /* @__PURE__ */ jsx4(TextInput, { label: "Folder in the bucket", value: prefix, onChange: setPrefix, placeholder: "voltius", hint: "Optional. Lets one bucket hold other data too." }),
          /* @__PURE__ */ jsx4(SecretInput, { label: "Access key ID", value: accessKeyId, onChange: setAccessKeyId, placeholder: "Access key ID" }),
          /* @__PURE__ */ jsx4(
            SecretInput,
            {
              label: "Secret access key",
              value: secretAccessKey,
              onChange: setSecretAccessKey,
              placeholder: "Secret access key",
              hint: /* @__PURE__ */ jsxs4(Fragment2, { children: [
                "Use a key limited to this one bucket. It is stored in this device's vault.",
                preset?.keysUrl && /* @__PURE__ */ jsxs4(Fragment2, { children: [
                  " ",
                  /* @__PURE__ */ jsx4(LinkButton, { onClick: () => openExternal(preset.keysUrl), children: "How to create one" })
                ] })
              ] })
            }
          ),
          /* @__PURE__ */ jsxs4("label", { className: "flex items-center gap-2 text-xs text-(--t-text-muted)", children: [
            /* @__PURE__ */ jsx4("input", { type: "checkbox", checked: addressing === "virtual", onChange: (e) => setAddressing(e.target.checked ? "virtual" : "path") }),
            "Put the bucket in the hostname (virtual-hosted style)"
          ] }),
          /* @__PURE__ */ jsx4(ActionRow, { reason: busy ?? connectReason, children: /* @__PURE__ */ jsx4(Btn, { onClick: connect, disabled: !!connectReason, busy: !!busy, children: "Test and connect" }) })
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
        existsHint: "This bucket already holds a synced vault. Enter the passphrase you chose when you created it.",
        onDone
      },
      connection ? "connected" : "none"
    )
  ] });
}

// src/SettingsPage.tsx
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function ConnectionCard({ api }) {
  const [rows, setRows] = useState5(null);
  useEffect2(() => {
    void loadS3Config(api).then((cfg) => {
      if (!cfg) return;
      setRows([
        ["Endpoint", cfg.endpoint],
        ["Region", cfg.region || "us-east-1"],
        ["Bucket", cfg.bucket],
        ["Folder", displayPrefix(cfg.prefix) || "(bucket root)"]
      ]);
    });
  }, [api]);
  if (!rows) return null;
  return /* @__PURE__ */ jsxs5(Card, { title: "Connection", children: [
    rows.map(([label, value]) => /* @__PURE__ */ jsx5(ConnectionRow, { label, value }, label)),
    /* @__PURE__ */ jsx5(Hint, { children: "To add another device, open S3 Sync there and enter the same endpoint, bucket, folder, an access key for this bucket and your passphrase." })
  ] });
}
function createSettingsPage(api, engine) {
  return function S3SyncSettingsPage() {
    return /* @__PURE__ */ jsx5(
      SettingsShell,
      {
        api,
        engine,
        icon: "lucide:database",
        intro: "Sync your data across devices through any S3-compatible bucket you own. Everything is encrypted on this device first; the bucket only ever stores ciphertext.",
        wizard: (onDone) => /* @__PURE__ */ jsx5(SetupWizard, { api, engine, onDone }),
        connection: /* @__PURE__ */ jsx5(ConnectionCard, { api }),
        disconnectHint: "Stops syncing on this device and forgets the bucket settings, access key and passphrase. Nothing is deleted from the bucket."
      }
    );
  };
}

// src/index.tsx
function register(api) {
  api.i18n.register(messages);
  const engine = createS3Engine(api);
  api.ui.registerSettingsPage({
    id: "s3-sync-settings",
    label: () => api.i18n.t("settingsLabel"),
    icon: "lucide:database",
    component: createSettingsPage(api, engine)
  });
  return engine.activate();
}
export {
  register as default
};
