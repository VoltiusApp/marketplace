import type { PluginAPI } from "@voltius/plugin-types";
import type { ConfigValues } from "../../shared/vault-sync/src/engine";

export type Addressing = "path" | "virtual";
export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  addressing: Addressing;
  accessKeyId: string;
  secretAccessKey: string;
};

export const STORAGE_KEYS = ["s3Endpoint", "s3Region", "s3Bucket", "s3Prefix", "s3Addressing"] as const;
export const VAULT_KEYS = ["s3AccessKeyId", "s3SecretAccessKey"] as const;

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".local")) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("s3-sync: the endpoint is required");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("s3-sync: the endpoint is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("s3-sync: the endpoint must start with https://");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("s3-sync: the endpoint must not contain a path — put the bucket in the Bucket field");
  }
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    throw new Error("s3-sync: the endpoint must use https:// (http:// only for localhost or a private network address)");
  }
  return `${url.protocol}//${url.host}`;
}

export function normalizePrefix(raw: string): string {
  const p = raw.trim().replace(/^\/+|\/+$/g, "");
  if (!p) return "";
  if (p.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new Error('s3-sync: the prefix cannot contain a "." or ".." segment');
  }
  return `${p}/`;
}

export function displayPrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+|\/+$/g, "");
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function validateBucket(bucket: string): void {
  if (!BUCKET_RE.test(bucket)) {
    throw new Error("s3-sync: bucket names are 3–63 lowercase letters, digits, dots or hyphens");
  }
}

export async function loadS3Config(api: PluginAPI): Promise<S3Config | null> {
  const [endpoint, region, bucket, prefix, addressing] = await Promise.all(
    STORAGE_KEYS.map((k) => api.storage.get<string>(k)),
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
    secretAccessKey,
  };
}

export function toConfigValues(cfg: S3Config): ConfigValues {
  return {
    storage: {
      s3Endpoint: cfg.endpoint,
      s3Region: cfg.region,
      s3Bucket: cfg.bucket,
      s3Prefix: cfg.prefix,
      s3Addressing: cfg.addressing,
    },
    vault: { s3AccessKeyId: cfg.accessKeyId, s3SecretAccessKey: cfg.secretAccessKey },
  };
}
