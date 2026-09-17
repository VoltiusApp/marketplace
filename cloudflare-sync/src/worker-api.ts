import { parseJson, send, type Http, type HttpResult } from "../../shared/vault-sync/src/http";

export type WorkerDevice = {
  id: string;
  label: string;
  pushedAt: string;
};

export type WorkerManifest = {
  schema: 1;
  salt: string;
  devices: WorkerDevice[];
};

export type ManifestGetResult = {
  manifest: WorkerManifest;
  etag: string | null;
};

export class WorkerApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "WorkerApiError";
  }
}

export function isConflictStatus(status: number): boolean {
  return status === 412 || status === 409;
}

function normalizeBaseUrl(workerUrl: string): string {
  return workerUrl.replace(/\/+$/, "");
}

function headers(token: string, ifMatch?: string | null): HeadersInit {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (ifMatch) h["If-Match"] = ifMatch;
  return h;
}

function checkResponse(res: HttpResult, context: string): void {
  if (!res.ok) {
    const parsed = parseJson<{ message?: string; error?: string }>(res.body);
    const message = parsed?.message ?? parsed?.error ?? res.body;
    throw new WorkerApiError(res.status, `${context}: ${message}`);
  }
}

async function call<T>(
  http: Http,
  workerUrl: string,
  path: string,
  context: string,
  init: RequestInit = {},
): Promise<{ data: T; res: HttpResult }> {
  const res = await send(http, `${normalizeBaseUrl(workerUrl)}${path}`, init);
  checkResponse(res, context);
  const data = parseJson<T>(res.body);
  if (data === null) throw new WorkerApiError(res.status, `${context}: response is not JSON`);
  return { data, res };
}

export async function getHealth(http: Http, workerUrl: string): Promise<{ ok: boolean; version: number }> {
  return (await call<{ ok: boolean; version: number }>(http, workerUrl, "/health", "getHealth")).data;
}

export async function getManifestWithEtag(
  http: Http,
  workerUrl: string,
  token: string,
): Promise<ManifestGetResult> {
  const { data, res } = await call<WorkerManifest>(http, workerUrl, "/v1/manifest", "getManifest", {
    headers: headers(token),
  });
  return { manifest: data, etag: res.headers.get("ETag") };
}

export async function getManifest(
  http: Http,
  workerUrl: string,
  token: string,
): Promise<WorkerManifest> {
  return (await getManifestWithEtag(http, workerUrl, token)).manifest;
}

export async function putManifest(
  http: Http,
  workerUrl: string,
  token: string,
  manifest: WorkerManifest,
  opts: { ifMatch?: string | null } = {},
): Promise<WorkerManifest> {
  const { data } = await call<WorkerManifest>(http, workerUrl, "/v1/manifest", "putManifest", {
    method: "PUT",
    headers: headers(token, opts.ifMatch),
    body: JSON.stringify(manifest),
  });
  return data;
}

function devicePath(deviceId: string): string {
  return `/v1/devices/${encodeURIComponent(deviceId)}`;
}

export async function getDeviceBlob(
  http: Http,
  workerUrl: string,
  token: string,
  deviceId: string,
): Promise<string> {
  const { data } = await call<{ content: string }>(
    http,
    workerUrl,
    devicePath(deviceId),
    `getDeviceBlob(${deviceId})`,
    { headers: headers(token) },
  );
  return data.content;
}

export async function getDeviceBlobs(
  http: Http,
  workerUrl: string,
  token: string,
  deviceIds: string[],
): Promise<string[]> {
  const blobs: string[] = [];
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

export async function putDeviceBlob(
  http: Http,
  workerUrl: string,
  token: string,
  deviceId: string,
  body: { content: string; label: string; pushedAt: string },
  opts: { ifMatch?: string | null } = {},
): Promise<void> {
  await call(http, workerUrl, devicePath(deviceId), `putDeviceBlob(${deviceId})`, {
    method: "PUT",
    headers: headers(token, opts.ifMatch),
    body: JSON.stringify(body),
  });
}

export async function deleteDevice(
  http: Http,
  workerUrl: string,
  token: string,
  deviceId: string,
): Promise<void> {
  await call(http, workerUrl, devicePath(deviceId), `deleteDevice(${deviceId})`, {
    method: "DELETE",
    headers: headers(token),
  });
}
