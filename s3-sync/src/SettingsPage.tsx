import React, { useEffect, useState } from "react";
import type { PluginAPI } from "@voltius/plugin-types";
import type { VaultSyncEngine } from "../../shared/vault-sync/src/engine";
import { Card, Hint } from "../../shared/vault-sync/src/ui/components";
import { SettingsShell } from "../../shared/vault-sync/src/ui/settings";
import { loadS3Config, normalizePrefix, type S3Config } from "./config";
import { SetupWizard } from "./SetupWizard";

function ConnectionCard({ api }: { api: PluginAPI }) {
  const [cfg, setCfg] = useState<S3Config | null>(null);
  useEffect(() => {
    void loadS3Config(api).then(setCfg);
  }, [api]);
  if (!cfg) return null;
  const rows: [string, string][] = [
    ["Endpoint", cfg.endpoint],
    ["Region", cfg.region || "us-east-1"],
    ["Bucket", cfg.bucket],
    ["Folder", normalizePrefix(cfg.prefix) || "(bucket root)"],
  ];
  return (
    <Card title="Connection">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-1">
          <span className="text-xs font-medium text-(--t-text-muted)">{label}</span>
          <span className="text-sm font-mono text-(--t-text-primary) break-all">{value}</span>
        </div>
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
