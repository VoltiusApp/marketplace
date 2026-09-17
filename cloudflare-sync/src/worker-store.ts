import type { Http } from "../../shared/vault-sync/src/http";
import { StoreError, type DeviceInfo, type DeviceVersion, type VaultStore } from "../../shared/vault-sync/src/store";
import {
  WorkerApiError,
  deleteDevice,
  getDeviceBlob,
  getManifest,
  getManifestWithEtag,
  isConflictStatus,
  putDeviceBlob,
  putManifest,
  type WorkerManifest,
} from "./worker-api";

export function toStoreError(err: unknown): unknown {
  if (!(err instanceof WorkerApiError)) return err;
  if (err.status === 401) {
    return new StoreError(
      "auth",
      "The Worker rejected the sync token. It must match the SYNC_TOKEN secret set on the Worker.",
      401,
    );
  }
  if (err.status === 404) return new StoreError("not_found", "Vault not found — re-configure in Settings", 404);
  if (isConflictStatus(err.status)) return new StoreError("conflict", err.message, err.status);
  return err;
}

const isNotFound = (err: unknown) => err instanceof WorkerApiError && err.status === 404;

export class WorkerStore implements VaultStore {
  constructor(
    private readonly http: Http,
    private readonly workerUrl: string,
    private readonly token: string,
  ) {}

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toStoreError(err);
    }
  }

  private manifest(): Promise<WorkerManifest> {
    return this.guard(() => getManifest(this.http, this.workerUrl, this.token));
  }

  async readSalt(): Promise<string | null> {
    try {
      return (await getManifest(this.http, this.workerUrl, this.token)).salt;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw toStoreError(err);
    }
  }

  async createSalt(salt: string): Promise<string> {
    return this.guard(async () => {
      const written = await putManifest(this.http, this.workerUrl, this.token, { schema: 1, salt, devices: [] });
      return written.salt;
    });
  }

  async listDevices(): Promise<DeviceVersion[]> {
    return (await this.manifest()).devices.map((d) => ({ id: d.id, version: d.pushedAt }));
  }

  async describeDevices(): Promise<DeviceInfo[]> {
    return (await this.manifest()).devices.map(({ id, label, pushedAt }) => ({ id, label, pushedAt }));
  }

  async getDevice(id: string): Promise<string | null> {
    try {
      return await getDeviceBlob(this.http, this.workerUrl, this.token, id);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw toStoreError(err);
    }
  }

  async putDevice(id: string, blob: string, info: { label: string; pushedAt: string }): Promise<void> {
    await this.guard(async () => {
      const { etag } = await getManifestWithEtag(this.http, this.workerUrl, this.token);
      await putDeviceBlob(this.http, this.workerUrl, this.token, id, { content: blob, ...info }, { ifMatch: etag });
    });
  }

  async deleteDevice(id: string): Promise<void> {
    await this.guard(() => deleteDevice(this.http, this.workerUrl, this.token, id));
  }
}
