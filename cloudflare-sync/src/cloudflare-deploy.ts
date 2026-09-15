import WORKER_SCRIPT from "../dist/worker.mjs";
import { parseJson, send, type Http, type HttpResult } from "./http";

const CF_API = "https://api.cloudflare.com/client/v4";

export const CLOUDFLARE_DASHBOARD_URL = "https://dash.cloudflare.com/";

const TOKEN_PERMISSIONS = [
  { key: "workers_scripts", type: "edit" },
  { key: "workers_r2", type: "edit" },
  { key: "account_settings", type: "read" },
];

export const CREATE_API_TOKEN_URL =
  "https://dash.cloudflare.com/profile/api-tokens?" +
  new URLSearchParams({
    permissionGroupKeys: JSON.stringify(TOKEN_PERMISSIONS),
    accountId: "*",
    zoneId: "all",
    name: "Voltius Cloudflare Sync",
  }).toString();

export const DEFAULT_WORKER_NAME = "voltius-cloudflare-sync";
export const DEFAULT_BUCKET_NAME = "voltius-vault-sync";
export const WORKER_COMPATIBILITY_DATE = "2025-09-06";
export const WORKER_COMPATIBILITY_FLAGS = ["nodejs_compat"] as const;
export const WORKER_MODULE_NAME = "worker.mjs";

export class CloudflareDeployError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "CloudflareDeployError";
  }
}

export type DeployWorkerInput = {
  accountId: string;
  apiToken: string;
  workerName: string;
  bucketName: string;
  syncToken: string;
};

export type DeployWorkerResult = {
  workerUrl: string;
  subdomain: string | null;
};

type CfEnvelope<T> = {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
};

function authHeaders(apiToken: string, extra?: Record<string, string>): HeadersInit {
  return {
    Authorization: `Bearer ${apiToken}`,
    Accept: "application/json",
    ...extra,
  };
}

function formatCfErrors(payload: CfEnvelope<unknown> | null, fallback: string): string {
  const msgs = payload?.errors?.map((e) => e.message).filter(Boolean) ?? [];
  if (msgs.length) return msgs.join("; ");
  return fallback;
}

function accountUrl(accountId: string, path: string): string {
  return `${CF_API}/accounts/${encodeURIComponent(accountId)}${path}`;
}

async function cfCall<T>(
  http: Http,
  url: string,
  context: string,
  init: RequestInit,
  tolerate?: (res: HttpResult, payload: CfEnvelope<T> | null) => boolean,
): Promise<T | null> {
  const res = await send(http, url, init);
  const payload = parseJson<CfEnvelope<T>>(res.body);
  if (tolerate?.(res, payload)) return null;

  if (res.status === 401 || res.status === 403) {
    throw new CloudflareDeployError(
      res.status,
      `${context}: Cloudflare rejected the API token (${res.status}). Check Workers Scripts Edit, Workers R2 Storage Edit, and Account Settings Read.`,
    );
  }
  if (!res.ok || payload?.success === false) {
    throw new CloudflareDeployError(res.status, `${context}: ${formatCfErrors(payload, res.body)}`);
  }
  return payload?.result ?? null;
}

export function generateSyncToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildMultipart(
  parts: Array<{ name: string; filename?: string; contentType: string; content: string }>,
): { body: string; contentType: string } {
  let boundary = "";
  do {
    boundary = `----voltius-${crypto.randomUUID()}`;
  } while (parts.some((p) => p.content.includes(boundary)));

  const body =
    parts
      .map((p) => {
        const filename = p.filename ? `; filename="${p.filename}"` : "";
        return (
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${p.name}"${filename}\r\n` +
          `Content-Type: ${p.contentType}\r\n\r\n` +
          `${p.content}\r\n`
        );
      })
      .join("") + `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function ensureR2Bucket(
  http: Http,
  accountId: string,
  apiToken: string,
  bucketName: string,
): Promise<void> {
  await cfCall(
    http,
    accountUrl(accountId, "/r2/buckets"),
    "ensureR2Bucket",
    {
      method: "POST",
      headers: authHeaders(apiToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: bucketName }),
    },
    (res, payload) => {
      if (res.status === 409) return true;
      const joined = formatCfErrors(payload, res.body).toLowerCase();
      return (
        res.status === 400 &&
        (joined.includes("already exists") ||
          joined.includes("bucket already") ||
          !!payload?.errors?.some((e) => e.code === 10004 || e.code === 10007))
      );
    },
  );
}

async function uploadWorkerScript(
  http: Http,
  accountId: string,
  apiToken: string,
  workerName: string,
  bucketName: string,
  syncToken: string,
): Promise<void> {
  const metadata = {
    main_module: WORKER_MODULE_NAME,
    compatibility_date: WORKER_COMPATIBILITY_DATE,
    compatibility_flags: [...WORKER_COMPATIBILITY_FLAGS],
    bindings: [
      { type: "r2_bucket", name: "VAULT_BUCKET", bucket_name: bucketName },
      { type: "secret_text", name: "SYNC_TOKEN", text: syncToken },
    ],
  };

  // The host sends request bodies as strings, so FormData cannot be used here.
  const { body, contentType } = buildMultipart([
    { name: "metadata", contentType: "application/json", content: JSON.stringify(metadata) },
    {
      name: WORKER_MODULE_NAME,
      filename: WORKER_MODULE_NAME,
      contentType: "application/javascript+module",
      content: WORKER_SCRIPT,
    },
  ]);

  await cfCall(
    http,
    accountUrl(accountId, `/workers/scripts/${encodeURIComponent(workerName)}`),
    "uploadWorkerScript",
    { method: "PUT", headers: authHeaders(apiToken, { "Content-Type": contentType }), body },
  );
}

export async function putWorkerSecret(
  http: Http,
  accountId: string,
  apiToken: string,
  workerName: string,
  name: string,
  text: string,
): Promise<void> {
  await cfCall(
    http,
    accountUrl(accountId, `/workers/scripts/${encodeURIComponent(workerName)}/secrets`),
    "putWorkerSecret",
    {
      method: "PUT",
      headers: authHeaders(apiToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name, text, type: "secret_text" }),
    },
  );
}

export async function getWorkersSubdomain(
  http: Http,
  accountId: string,
  apiToken: string,
): Promise<string | null> {
  const result = await cfCall<{ subdomain?: string }>(
    http,
    accountUrl(accountId, "/workers/subdomain"),
    "getWorkersSubdomain",
    { method: "GET", headers: authHeaders(apiToken) },
    (res) => res.status === 404,
  );
  return result?.subdomain?.trim() || null;
}

export async function enableWorkersDev(
  http: Http,
  accountId: string,
  apiToken: string,
  workerName: string,
): Promise<void> {
  await cfCall(
    http,
    accountUrl(accountId, `/workers/scripts/${encodeURIComponent(workerName)}/subdomain`),
    "enableWorkersDev",
    {
      method: "POST",
      headers: authHeaders(apiToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled: true }),
    },
    (res) => res.status === 404,
  );
}

export async function deployWorker(
  http: Http,
  input: DeployWorkerInput,
): Promise<DeployWorkerResult> {
  const accountId = input.accountId.trim();
  const apiToken = input.apiToken.trim();
  const workerName = (input.workerName.trim() || DEFAULT_WORKER_NAME).replace(/[^a-zA-Z0-9_-]/g, "-");
  const bucketName = (input.bucketName.trim() || DEFAULT_BUCKET_NAME)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
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
    // Non-fatal: the script and secret are uploaded; the URL can still be pasted by hand.
  }

  const subdomain = await getWorkersSubdomain(http, accountId, apiToken);
  if (subdomain) {
    return { workerUrl: `https://${workerName}.${subdomain}.workers.dev`, subdomain };
  }
  return { workerUrl: "", subdomain: null };
}
