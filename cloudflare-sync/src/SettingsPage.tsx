import React, { useEffect, useState } from "react";
import type { PluginAPI } from "@voltius/plugin-types";
import type { VaultSyncEngine } from "../../shared/vault-sync/src/engine";
import { Card, copyText, ErrorBanner, Hint, LinkButton, useAction } from "../../shared/vault-sync/src/ui/components";
import { SettingsShell } from "../../shared/vault-sync/src/ui/settings";
import { SetupWizard } from "./SetupWizard";

function ConnectionCard({ api }: { api: PluginAPI }) {
  const [workerUrl, setWorkerUrl] = useState("");
  const { error, run } = useAction();
  useEffect(() => {
    void api.storage.get<string>("workerUrl").then((u) => setWorkerUrl(u ?? ""));
  }, [api]);
  const copyToken = () =>
    run("copy", async () => {
      const token = await api.vault.get("syncToken");
      if (!token) throw new Error("No sync token is stored on this device.");
      await copyText(token);
      api.notifications.toast("Sync token copied", { severity: "success" });
    });
  return (
    <Card title="Connection">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-(--t-text-muted)">Worker URL</span>
        <span className="text-sm font-mono text-(--t-text-primary) break-all">{workerUrl}</span>
      </div>
      {error && <ErrorBanner message={error} />}
      <Hint>
        To add another device, open Cloudflare Sync there, choose <span className="font-medium">I already have one</span>, and
        enter this Worker URL, the sync token (<LinkButton onClick={() => void copyToken()}>copy it</LinkButton>) and your
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
