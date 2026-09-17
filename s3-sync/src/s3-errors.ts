import { StoreError } from "../../shared/vault-sync/src/store";
import { parseErrorBody } from "./s3-xml";

const AUTH_CODES = new Set(["InvalidAccessKeyId", "SignatureDoesNotMatch", "AccessDenied", "AllAccessDisabled", "AccountProblem"]);
const WRONG_REGION_CODES = new Set(["AuthorizationHeaderMalformed", "PermanentRedirect"]);

export function toStoreError(status: number, body: string): StoreError {
  const { code, message } = parseErrorBody(body);
  if (code === "RequestTimeTooSkewed") {
    return new StoreError("clock", "This device's clock is off, so the storage provider rejected the request. Fix the system time and try again.", status);
  }
  if (status === 401 || (code !== null && AUTH_CODES.has(code)) || (status === 403 && code === null)) {
    return new StoreError("auth", "The storage provider rejected the access key or secret, or the key cannot access this bucket.", status);
  }
  if (code === "NoSuchBucket") {
    return new StoreError("not_found", "Bucket not found — check the bucket name, region and endpoint.", status);
  }
  if (code !== null && WRONG_REGION_CODES.has(code)) {
    return new StoreError("not_found", "This bucket lives in another region or behind another endpoint — check the region and endpoint.", status);
  }
  if (status === 412 || status === 409) return new StoreError("conflict", "The object changed while writing it", status);
  return new StoreError("other", code ? `${code}: ${message ?? `HTTP ${status}`}` : `HTTP ${status}`, status);
}
