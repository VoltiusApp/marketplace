import type { PluginAPI } from "@voltius/plugin-types";
import { createVaultSyncEngine } from "../../shared/vault-sync/src/engine";
import { loadS3Config, STORAGE_KEYS, VAULT_KEYS } from "./config";
import { S3Store } from "./s3-store";

export function createS3Engine(api: PluginAPI) {
  return createVaultSyncEngine({
    api,
    storageKeys: STORAGE_KEYS,
    vaultKeys: VAULT_KEYS,
    openStore: async () => {
      const cfg = await loadS3Config(api);
      return cfg ? new S3Store(api.http, cfg) : null;
    },
  });
}
