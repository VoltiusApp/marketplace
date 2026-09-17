import { useEffect, useState } from "react";
import type { PluginAPI } from "@voltius/plugin-types";
import type { VaultSyncEngine } from "../../shared/vault-sync/src/engine";
import { Card, ConnectionRow, ErrorBanner, Hint, LinkButton, useAction } from "../../shared/vault-sync/src/ui/components";
import { SettingsShell } from "../../shared/vault-sync/src/ui/settings";
import { copyToken } from "./copyToken";
import { SetupWizard } from "./SetupWizard";

function ConnectionCard({ api }: { api: PluginAPI }) {
  const [workerUrl, setWorkerUrl] = useState("");
  const { error, run } = useAction();
  useEffect(() => {
    void api.storage.get<string>("workerUrl").then((u) => setWorkerUrl(u ?? ""));
  }, [api]);
  const copyStoredToken = () => run("copy", async () => copyToken(api, await api.vault.get("syncToken")));
  return (
    <Card title="Connection">
      <ConnectionRow label="Worker URL" value={workerUrl} />
      {error && <ErrorBanner message={error} />}
      <Hint>
        To add another device, open Cloudflare Sync there, choose <span className="font-medium">I already have one</span>, and
        enter this Worker URL, the sync token (<LinkButton onClick={() => void copyStoredToken()}>copy it</LinkButton>) and your
        passphrase.
      </Hint>
    </Card>
  );
}

export function createSettingsPage(api: PluginAPI, engine: VaultSyncEngine) {
  return function CloudflareSyncSettingsPage() {
    return (
      <SettingsShell
        api={api}
        engine={engine}
        icon="lucide:cloud"
        intro="Sync your data across devices through your own Cloudflare Worker and R2 bucket. Everything is encrypted on this device first; the Worker only ever stores ciphertext."
        wizard={(onDone) => <SetupWizard api={api} engine={engine} onDone={onDone} />}
        connection={<ConnectionCard api={api} />}
        disconnectHint="Stops syncing on this device and forgets the Worker URL, sync token and passphrase. Nothing is deleted from the Worker."
      />
    );
  };
}
