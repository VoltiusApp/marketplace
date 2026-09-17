import { useState } from "react";
import type { PluginAPI } from "@voltius/plugin-types";
import type { VaultSyncEngine } from "../../shared/vault-sync/src/engine";
import { Btn, ErrorBanner, Hint, INPUT_CLASS, LinkButton, SecretInput, TextInput, openExternal, useAction } from "../../shared/vault-sync/src/ui/components";
import { ActionRow, PassphraseStep, StepCard, type Connection } from "../../shared/vault-sync/src/ui/wizard";
import { displayPrefix, normalizeEndpoint, normalizePrefix, toConfigValues, validateBucket, type Addressing, type S3Config } from "./config";
import { endpointFor, PRESETS, type Preset } from "./presets";
import { S3Store } from "./s3-store";

export function SetupWizard({ api, engine, onDone }: { api: PluginAPI; engine: VaultSyncEngine; onDone: () => void }) {
  const [preset, setPreset] = useState<Preset | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [summary, setSummary] = useState("");
  const { busy, error, setError, run } = useAction();

  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("voltius");
  const [addressing, setAddressing] = useState<Addressing>("path");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");

  const choosePreset = (p: Preset) => {
    setPreset(p);
    setRegion(p.region);
    setEndpoint(endpointFor(p, p.region));
    setAddressing(p.addressing);
  };

  const changeRegion = (value: string) => {
    setRegion(value);
    if (preset?.endpoint.includes("{region}")) setEndpoint(endpointFor(preset, value));
  };

  const connect = () =>
    run("Testing the bucket…", async () => {
      validateBucket({ bucket: bucket.trim(), addressing, endpoint });
      const cfg: S3Config = {
        endpoint: normalizeEndpoint(endpoint),
        region: region.trim(),
        bucket: bucket.trim(),
        prefix: normalizePrefix(prefix),
        addressing,
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
      };
      const store = new S3Store(api.http, cfg);
      await store.probe();
      const vault = await engine.detectVault(store);
      setSummary(`${cfg.endpoint} · ${cfg.bucket}${cfg.prefix ? `/${displayPrefix(cfg.prefix)}` : ""}`);
      setConnection({ store, vault, values: toConfigValues(cfg) });
    });

  const connectReason = !endpoint.trim()
    ? "Enter the endpoint"
    : !bucket.trim()
      ? "Enter the bucket name"
      : !accessKeyId.trim() || !secretAccessKey.trim()
        ? "Enter the access key and secret"
        : null;

  return (
    <div className="flex flex-col gap-3">
      {error && <ErrorBanner message={error} />}
      <StepCard
        n={1}
        title="Which storage provider?"
        state={preset ? "done" : "active"}
        summary={preset?.name}
        onChange={busy ? undefined : () => { setPreset(null); setConnection(null); setError(null); }}
      >
        <select className={INPUT_CLASS} value="" onChange={(e) => { const p = PRESETS.find((x) => x.id === e.target.value); if (p) choosePreset(p); }}>
          <option value="" disabled>Choose a provider</option>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <Hint>Any S3-compatible service works. Pick Other if yours is not listed.</Hint>
      </StepCard>

      <StepCard
        n={2}
        title="Connect to your bucket"
        state={!preset ? "locked" : connection ? "done" : "active"}
        summary={<span className="font-mono">{summary}</span>}
        onChange={busy ? undefined : () => { setConnection(null); setError(null); }}
      >
        <TextInput label="Endpoint" value={endpoint} onChange={setEndpoint} placeholder="https://s3.example.com" hint={preset?.endpointHint} />
        <TextInput label="Region" value={region} onChange={changeRegion} hint={preset?.regionHint} />
        <TextInput label="Bucket" value={bucket} onChange={setBucket} placeholder="voltius-vault" hint="Create the bucket first, in your provider's console." />
        <TextInput label="Folder in the bucket" value={prefix} onChange={setPrefix} placeholder="voltius" hint="Optional. Lets one bucket hold other data too." />
        <SecretInput label="Access key ID" value={accessKeyId} onChange={setAccessKeyId} placeholder="Access key ID" />
        <SecretInput
          label="Secret access key"
          value={secretAccessKey}
          onChange={setSecretAccessKey}
          placeholder="Secret access key"
          hint={
            <>
              Use a key limited to this one bucket. It is stored in this device's vault.
              {preset?.keysUrl && (
                <> <LinkButton onClick={() => openExternal(preset.keysUrl!)}>How to create one</LinkButton></>
              )}
            </>
          }
        />
        <label className="flex items-center gap-2 text-xs text-(--t-text-muted)">
          <input type="checkbox" checked={addressing === "virtual"} onChange={(e) => setAddressing(e.target.checked ? "virtual" : "path")} />
          Put the bucket in the hostname (virtual-hosted style)
        </label>
        <ActionRow reason={busy ?? connectReason}>
          <Btn onClick={connect} disabled={!!connectReason} busy={!!busy}>
            Test and connect
          </Btn>
        </ActionRow>
      </StepCard>

      <PassphraseStep
        key={connection ? "connected" : "none"}
        n={3}
        api={api}
        engine={engine}
        connection={connection}
        busy={busy}
        run={run}
        existsHint="This bucket already holds a synced vault. Enter the passphrase you chose when you created it."
        onDone={onDone}
      />
    </div>
  );
}
