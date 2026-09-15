import React, { useCallback, useEffect, useState } from "react";
import { Icon } from "@voltius/ui";
import type { PluginAPI } from "@voltius/plugin-types";
import { Btn, Card, copyText, Dot, ErrorBanner, Hint, LinkButton, useAction } from "./components";
import { SetupWizard } from "./SetupWizard";
import {
  disconnect,
  getCloudflareSyncState,
  getDeviceId,
  isConfigured,
  onCloudflareSyncStateChange,
  removeRemoteDevice,
  startPoll,
  stopPoll,
  syncNow,
} from "./sync-engine";
import { getManifest, type WorkerDevice } from "./worker-api";

function useSyncState() {
  const [state, setState] = useState(getCloudflareSyncState);
  useEffect(() => onCloudflareSyncStateChange(() => setState(getCloudflareSyncState())), []);
  return state;
}

function ConfiguredView({ api }: { api: PluginAPI }) {
  const sync = useSyncState();
  const [workerUrl, setWorkerUrl] = useState("");
  const [devices, setDevices] = useState<WorkerDevice[] | null>(null);
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [pollSeconds, setPollSeconds] = useState(60);
  const { busy, error, run } = useAction();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const loadDevices = useCallback(async () => {
    const [url, token] = await Promise.all([api.storage.get<string>("workerUrl"), api.vault.get("syncToken")]);
    setWorkerUrl(url ?? "");
    if (!url || !token) return;
    try {
      setDevices((await getManifest(api.http, url, token)).devices);
    } catch {
      setDevices(null);
    }
  }, [api]);

  useEffect(() => {
    void loadDevices();
    void getDeviceId().then(setLocalDeviceId);
    void api.storage.get<number>("pollIntervalSeconds").then((v) => v && setPollSeconds(v));
  }, [api, loadDevices]);

  useEffect(() => {
    if (sync.status === "success") void loadDevices();
  }, [sync.lastSync, sync.status, loadDevices]);

  const copyToken = () =>
    run("copy", async () => {
      const token = await api.vault.get("syncToken");
      if (!token) throw new Error("No sync token is stored on this device.");
      await copyText(token);
      api.notifications.toast("Sync token copied", { severity: "success" });
    });

  return (
    <>
      {(error || sync.error) && <ErrorBanner message={error ?? sync.error!} />}

      <Card title="Sync">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="flex items-center gap-2 text-sm text-(--t-text-primary)">
              <Dot tone={sync.status === "error" ? "error" : sync.status === "success" ? "connected" : "idle"} />
              {sync.status === "syncing"
                ? "Syncing…"
                : sync.status === "error"
                  ? "Last sync failed"
                  : sync.status === "offline"
                    ? "Offline"
                    : "Up to date"}
            </span>
            <span className="text-xs text-(--t-text-dim)">
              {sync.lastSync ? `Last synced ${sync.lastSync.toLocaleString()}` : "Not synced yet in this session"}
            </span>
          </div>
          <Btn onClick={() => void run("sync", () => syncNow({ showProgress: true }))} busy={busy === "sync" || sync.status === "syncing"}>
            Sync now
          </Btn>
        </div>
        <div className="flex items-center justify-between gap-4 pt-3 border-t border-(--t-border)">
          <span className="text-sm text-(--t-text-muted)">Check for changes every</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={10}
              max={3600}
              className="form-input w-20 px-2 py-1 rounded-lg text-sm outline-hidden bg-(--t-bg-input) border border-(--t-border) text-(--t-text-primary)"
              value={pollSeconds}
              onChange={(e) => setPollSeconds(Number(e.target.value) || 60)}
              onBlur={() => {
                const clamped = Math.min(3600, Math.max(10, pollSeconds || 60));
                setPollSeconds(clamped);
                void api.storage.set("pollIntervalSeconds", clamped).then(() => {
                  stopPoll();
                  startPoll(clamped);
                });
              }}
            />
            <span className="text-sm text-(--t-text-dim)">seconds</span>
          </div>
        </div>
      </Card>

      <Card title="Connection">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-(--t-text-muted)">Worker URL</span>
          <span className="text-sm font-mono text-(--t-text-primary) break-all">{workerUrl}</span>
        </div>
        <Hint>
          To add another device, open Cloudflare Sync there, choose <span className="font-medium">I already have one</span>, and
          enter this Worker URL, the sync token (<LinkButton onClick={() => void copyToken()}>copy it</LinkButton>) and your
          passphrase.
        </Hint>
      </Card>

      <Card title={devices ? `Devices (${devices.length})` : "Devices"}>
        {devices === null ? (
          <Hint>Could not load the device list.</Hint>
        ) : (
          <div className="flex flex-col gap-1.5">
            {devices.map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-(--t-border) bg-(--t-bg-base)"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Icon icon="lucide:monitor" width={14} className="text-(--t-text-dim) shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-(--t-text-primary) truncate">
                      {d.label || d.id}
                      {d.id === localDeviceId && <span className="text-(--t-text-dim)"> · this device</span>}
                    </p>
                    <p className="text-xs text-(--t-text-dim) truncate">Last pushed {new Date(d.pushedAt).toLocaleString()}</p>
                  </div>
                </div>
                {d.id !== localDeviceId && (
                  <Btn
                    small
                    variant="secondary"
                    busy={busy === `remove:${d.id}`}
                    disabled={!!busy}
                    onClick={() => void run(`remove:${d.id}`, async () => { await removeRemoteDevice(d.id); await loadDevices(); })}
                  >
                    Remove
                  </Btn>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Disconnect">
        <Hint>Stops syncing on this device and forgets the Worker URL, sync token and passphrase. Nothing is deleted from the Worker.</Hint>
        <div className="flex items-center gap-2">
          {confirmDisconnect ? (
            <>
              <Btn variant="danger" busy={busy === "disconnect"} onClick={() => void run("disconnect", disconnect)}>
                Yes, disconnect
              </Btn>
              <Btn variant="secondary" onClick={() => setConfirmDisconnect(false)}>
                Cancel
              </Btn>
            </>
          ) : (
            <Btn variant="danger" onClick={() => setConfirmDisconnect(true)}>
              Disconnect this device
            </Btn>
          )}
        </div>
      </Card>
    </>
  );
}

export function createSettingsPage(api: PluginAPI) {
  return function CloudflareSyncSettingsPage() {
    const sync = useSyncState();
    const [configured, setConfigured] = useState<boolean | null>(null);

    useEffect(() => {
      void isConfigured().then(setConfigured);
    }, [sync.configured]);

    return (
      <div className="flex flex-col gap-6 max-w-lg">
        <div className="flex items-center gap-2">
          <Icon icon="lucide:cloud" width={20} className="text-(--t-text-primary)" />
          <h2 className="text-base font-semibold text-(--t-text-primary)">{api.i18n.t("settingsLabel")}</h2>
          {configured && <Dot tone={sync.status === "error" ? "error" : "connected"} />}
        </div>

        <p className="text-sm text-(--t-text-dim) -mt-4">
          Sync your data across devices through your own Cloudflare Worker and R2 bucket. Everything is encrypted on this
          device first; the Worker only ever stores ciphertext.
        </p>

        {configured === false && <SetupWizard api={api} onDone={() => setConfigured(true)} />}
        {configured && <ConfiguredView api={api} />}
      </div>
    );
  };
}
