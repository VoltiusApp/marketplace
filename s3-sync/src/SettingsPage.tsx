import { useEffect, useState } from "react";
import type { PluginAPI } from "@voltius/plugin-types";
import type { VaultSyncEngine } from "../../shared/vault-sync/src/engine";
import { Card, ConnectionRow, Hint } from "../../shared/vault-sync/src/ui/components";
import { SettingsShell } from "../../shared/vault-sync/src/ui/settings";
import { displayPrefix, loadS3Config } from "./config";
import { SetupWizard } from "./SetupWizard";

function ConnectionCard({ api }: { api: PluginAPI }) {
  const [rows, setRows] = useState<[string, string][] | null>(null);
  useEffect(() => {
    void loadS3Config(api).then((cfg) => {
      if (!cfg) return;
      setRows([
        ["Endpoint", cfg.endpoint],
        ["Region", cfg.region || "us-east-1"],
        ["Bucket", cfg.bucket],
        ["Folder", displayPrefix(cfg.prefix) || "(bucket root)"],
      ]);
    });
  }, [api]);
  if (!rows) return null;
  return (
    <Card title="Connection">
      {rows.map(([label, value]) => (
        <ConnectionRow key={label} label={label} value={value} />
      ))}
      <Hint>
        To add another device, open S3 Sync there and enter the same endpoint, bucket, folder, an access key for this
        bucket and your passphrase.
      </Hint>
    </Card>
  );
}

export function createSettingsPage(api: PluginAPI, engine: VaultSyncEngine) {
  return function S3SyncSettingsPage() {
    return (
      <SettingsShell
        api={api}
        engine={engine}
        icon="lucide:database"
        intro="Sync your data across devices through any S3-compatible bucket you own. Everything is encrypted on this device first; the bucket only ever stores ciphertext."
        wizard={(onDone) => <SetupWizard api={api} engine={engine} onDone={onDone} />}
        connection={<ConnectionCard api={api} />}
        disconnectHint="Stops syncing on this device and forgets the bucket settings, access key and passphrase. Nothing is deleted from the bucket."
      />
    );
  };
}
