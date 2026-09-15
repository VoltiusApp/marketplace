import type { PluginAPI } from "@voltius/plugin-types";

export type Http = PluginAPI["http"];

export type HttpResult = {
  status: number;
  ok: boolean;
  headers: Headers;
  body: string;
};

export const REQUEST_TIMEOUT_MS = 60_000;

export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null;
  } catch {
    return null;
  }
}

export async function send(
  http: Http,
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<HttpResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The host's stream ignores an abort that lands before the response headers, so race it too.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${timeoutMs / 1000}s: ${url}`));
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
