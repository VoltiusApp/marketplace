import { vi } from "vitest";
import type { PluginAPI } from "@voltius/plugin-types";
import type { DeviceInfo, DeviceVersion, VaultStore } from "../store";

export function fakeApi() {
  const storage = new Map<string, unknown>();
  const vault = new Map<string, string>();
  const published: unknown[] = [];
  const imported: string[][] = [];
  let exports = 0;
  const api = {
    storage: {
      get: async (k: string) => (storage.has(k) ? storage.get(k) : null),
      set: async (k: string, v: unknown) => void storage.set(k, v),
      delete: async (k: string) => void storage.delete(k),
    },
    vault: {
      get: async (k: string) => vault.get(k) ?? null,
      set: async (k: string, v: string) => void vault.set(k, v),
      delete: async (k: string) => void vault.delete(k),
    },
    crypto: { deriveKey: async (p: string, s: string) => `key(${p},${s})` },
    sync: {
      exportState: async (key: string, deviceId: string) => `${key}|${deviceId}|${++exports}`,
      importStates: async (key: string, blobs: string[]) => {
        for (const b of blobs) if (!b.startsWith(`${key}|`)) throw new Error("decrypt failed");
        imported.push(blobs);
      },
    },
    ui: { publishState: (_k: string, v: unknown) => void published.push(v) },
    plugins: { expose: vi.fn() },
    isActive: () => false,
    lifecycle: { onBeforeQuit: () => () => {} },
  };
  return { api: api as unknown as PluginAPI, storage, vault, published, imported };
}

type Stored = { blob: string; label: string; pushedAt: string; version: number };

export class MemoryStore implements VaultStore {
  salt: string | null = null;
  devices = new Map<string, Stored>();
  failNext: Error[] = [];
  calls = 0;

  private tick() {
    this.calls++;
    const err = this.failNext.shift();
    if (err) throw err;
  }
  async readSalt() {
    this.tick();
    return this.salt;
  }
  async createSalt(salt: string) {
    this.tick();
    this.salt ??= salt;
    return this.salt;
  }
  async listDevices(): Promise<DeviceVersion[]> {
    this.tick();
    return [...this.devices].map(([id, d]) => ({ id, version: String(d.version) }));
  }
  async describeDevices(): Promise<DeviceInfo[]> {
    this.tick();
    return [...this.devices].map(([id, d]) => ({ id, label: d.label, pushedAt: d.pushedAt }));
  }
  async getDevice(id: string) {
    this.tick();
    return this.devices.get(id)?.blob ?? null;
  }
  async putDevice(id: string, blob: string, info: { label: string; pushedAt: string }) {
    this.tick();
    this.devices.set(id, { blob, ...info, version: (this.devices.get(id)?.version ?? 0) + 1 });
  }
  async deleteDevice(id: string) {
    this.tick();
    this.devices.delete(id);
  }
}

export type RecordedRequest = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

export function fakeHttp(
  handler: (req: RecordedRequest) => { status: number; body?: string; headers?: Record<string, string> },
) {
  const requests: RecordedRequest[] = [];
  const http = {
    stream: async (url: string, init: RequestInit = {}) => {
      const headers = Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      );
      const req = { url, method: (init.method ?? "GET").toUpperCase(), headers, body: init.body as string | undefined };
      requests.push(req);
      const res = handler(req);
      return new Response(res.body ?? "", { status: res.status, headers: res.headers });
    },
  };
  return { http: http as unknown as PluginAPI["http"], requests };
}
