export type StoreErrorKind = "auth" | "not_found" | "clock" | "conflict" | "other";

export class StoreError extends Error {
  constructor(
    public readonly kind: StoreErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export type DeviceVersion = { id: string; version: string };
export type DeviceInfo = { id: string; label: string; pushedAt: string };

export interface VaultStore {
  readSalt(): Promise<string | null>;
  /** Returns the salt actually stored, which may be another device's. */
  createSalt(salt: string): Promise<string>;
  listDevices(): Promise<DeviceVersion[]>;
  describeDevices(): Promise<DeviceInfo[]>;
  getDevice(id: string): Promise<string | null>;
  putDevice(id: string, blob: string, info: { label: string; pushedAt: string }): Promise<void>;
  deleteDevice(id: string): Promise<void>;
}

export const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
