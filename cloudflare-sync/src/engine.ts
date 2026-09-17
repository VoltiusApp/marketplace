import type { PluginAPI } from "@voltius/plugin-types";
import { createVaultSyncEngine } from "../../shared/vault-sync/src/engine";
import { WorkerStore } from "./worker-store";

export function createCloudflareEngine(api: PluginAPI) {
  return createVaultSyncEngine({
    api,
    storageKeys: ["workerUrl"],
    vaultKeys: ["syncToken"],
    openStore: async () => {
      const [url, token] = await Promise.all([api.storage.get<string>("workerUrl"), api.vault.get("syncToken")]);
      return url && token ? new WorkerStore(api.http, url, token) : null;
    },
  });
}
