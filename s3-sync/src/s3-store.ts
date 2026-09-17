import { send, type Http, type HttpResult } from "../../shared/vault-sync/src/http";
import { DEVICE_ID_RE, StoreError, type DeviceInfo, type DeviceVersion, type VaultStore } from "../../shared/vault-sync/src/store";
import { normalizeEndpoint, normalizePrefix, validateBucket, type S3Config } from "./config";
import { md5Base64 } from "./md5";
import { toStoreError } from "./s3-errors";
import { deleteErrors, escapeXml, parseErrorBody, parseListObjects } from "./s3-xml";
import { canonicalQuery, encodeKeyPath, encodeRfc3986, signRequest } from "./sigv4";

export const VAULT_KEY = "vault.json";
export const PROBE_KEY = ".voltius-probe";
const DEVICES_DIR = "devices/";
const SALT_RE = /^[0-9a-f]{32}$/i;

type RequestOptions = { query?: [string, string][]; headers?: Record<string, string>; body?: string };

export class S3Store implements VaultStore {
  private readonly endpoint: URL;
  private readonly prefix: string;

  constructor(
    private readonly http: Http,
    private readonly cfg: S3Config,
    private readonly now: () => Date = () => new Date(),
  ) {
    validateBucket(cfg.bucket);
    this.endpoint = new URL(normalizeEndpoint(cfg.endpoint));
    this.prefix = normalizePrefix(cfg.prefix);
  }

  private target(key: string | null): { host: string; path: string } {
    const encoded = key === null ? "" : encodeKeyPath(key);
    if (this.cfg.addressing === "virtual") {
      return { host: `${this.cfg.bucket}.${this.endpoint.host}`, path: `/${encoded}` };
    }
    return { host: this.endpoint.host, path: `/${encodeRfc3986(this.cfg.bucket)}${key === null ? "" : `/${encoded}`}` };
  }

  private async request(method: string, key: string | null, opts: RequestOptions = {}): Promise<HttpResult> {
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
      now: this.now(),
    });
    const qs = canonicalQuery(query);
    return send(this.http, `${this.endpoint.protocol}//${host}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers,
      body: method === "GET" ? undefined : body,
    });
  }

  private key(name: string): string {
    return `${this.prefix}${name}`;
  }

  private isMissingObject(res: HttpResult): boolean {
    return res.status === 404 && parseErrorBody(res.body).code !== "NoSuchBucket";
  }

  private async getText(name: string): Promise<string | null> {
    const res = await this.request("GET", this.key(name));
    if (res.ok) return res.body;
    if (this.isMissingObject(res)) return null;
    throw toStoreError(res.status, res.body);
  }

  private async putText(name: string, body: string, contentType: string, headers: Record<string, string> = {}) {
    const res = await this.request("PUT", this.key(name), { body, headers: { "content-type": contentType, ...headers } });
    if (!res.ok) throw toStoreError(res.status, res.body);
  }

  // Single-object DELETE answers 204, which released hosts' HTTP bridge cannot deliver.
  private async deleteKeys(names: string[]) {
    const objects = names.map((n) => `<Object><Key>${escapeXml(this.key(n))}</Key></Object>`).join("");
    const body = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${objects}</Delete>`;
    const res = await this.request("POST", null, {
      query: [["delete", ""]],
      body,
      headers: { "content-md5": md5Base64(body), "content-type": "application/xml" },
    });
    if (!res.ok) throw toStoreError(res.status, res.body);
    const [failed] = deleteErrors(res.body);
    if (failed) throw toStoreError(res.status, failed);
  }

  async readSalt(): Promise<string | null> {
    const text = await this.getText(VAULT_KEY);
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text) as { schema?: unknown; salt?: unknown };
      if (parsed.schema === 1 && typeof parsed.salt === "string" && SALT_RE.test(parsed.salt)) return parsed.salt;
    } catch {}
    throw new StoreError("other", `${this.key(VAULT_KEY)} in this bucket is not a Voltius vault`);
  }

  async createSalt(salt: string): Promise<string> {
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

  async listDevices(): Promise<DeviceVersion[]> {
    const dir = this.key(DEVICES_DIR);
    const out: DeviceVersion[] = [];
    let token: string | null = null;
    do {
      const query: [string, string][] = [["list-type", "2"], ["prefix", dir]];
      if (token) query.push(["continuation-token", token]);
      const res = await this.request("GET", null, { query });
      if (!res.ok) throw toStoreError(res.status, res.body);
      const page = parseListObjects(res.body);
      for (const o of page.objects) {
        const rest = o.key.slice(dir.length);
        if (!o.key.startsWith(dir) || !rest.endsWith(".b64")) continue;
        const id = rest.slice(0, -4);
        if (DEVICE_ID_RE.test(id)) out.push({ id, version: o.etag });
      }
      token = page.truncated ? page.nextToken : null;
    } while (token);
    return out;
  }

  async describeDevices(): Promise<DeviceInfo[]> {
    const devices = await this.listDevices();
    return Promise.all(
      devices.map(async ({ id }) => {
        try {
          const text = await this.getText(`${DEVICES_DIR}${id}.json`);
          const meta = JSON.parse(text ?? "") as { label?: unknown; pushedAt?: unknown };
          return {
            id,
            label: typeof meta.label === "string" && meta.label ? meta.label : id,
            pushedAt: typeof meta.pushedAt === "string" ? meta.pushedAt : "",
          };
        } catch {
          return { id, label: id, pushedAt: "" };
        }
      }),
    );
  }

  private requireDeviceId(id: string): void {
    if (!DEVICE_ID_RE.test(id)) throw new StoreError("other", `"${id}" is not a valid device id`);
  }

  async getDevice(id: string): Promise<string | null> {
    this.requireDeviceId(id);
    return this.getText(`${DEVICES_DIR}${id}.b64`);
  }

  async putDevice(id: string, blob: string, info: { label: string; pushedAt: string }): Promise<void> {
    this.requireDeviceId(id);
    await this.putText(`${DEVICES_DIR}${id}.b64`, blob, "text/plain; charset=utf-8");
    await this.putText(`${DEVICES_DIR}${id}.json`, JSON.stringify(info), "application/json");
  }

  async deleteDevice(id: string): Promise<void> {
    await this.deleteKeys([`${DEVICES_DIR}${id}.b64`, `${DEVICES_DIR}${id}.json`]);
  }

  async probe(): Promise<void> {
    const step = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        const message = `${label} test failed: ${err instanceof Error ? err.message : String(err)}`;
        throw err instanceof StoreError ? new StoreError(err.kind, message, err.status) : new Error(message);
      }
    };
    await step("Write", () => this.putText(PROBE_KEY, "ok", "text/plain; charset=utf-8"));
    await step("Read", async () => {
      if ((await this.getText(PROBE_KEY)) !== "ok") throw new Error("the bucket did not return what was written");
    });
    await step("Delete", () => this.deleteKeys([PROBE_KEY]));
  }
}
