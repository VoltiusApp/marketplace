import { WorkerApiError } from "./worker-api";

export function describeError(err: unknown): string {
  if (err instanceof WorkerApiError && err.status === 401) {
    return "The Worker rejected the sync token. It must match the SYNC_TOKEN secret set on the Worker.";
  }
  const message = (err instanceof Error ? err.message : String(err)).replace(/^cloudflare-sync:\s*/, "");
  return message.charAt(0).toUpperCase() + message.slice(1);
}
