import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@voltius/ui";
import type { PluginAPI } from "@voltius/plugin-types";
import type { VaultSyncEngine } from "../engine";
import type { DeviceInfo } from "../store";
import { Btn, Card, Dot, ErrorBanner, Hint, useAction } from "./components";

export function useEngineState(engine: VaultSyncEngine) {
  const [state, setState] = useState(engine.getState);
  useEffect(() => engine.onStateChange(() => setState(engine.getState())), [engine]);
  return state;
}

function ConfiguredView({
  api,
  engine,
  connection,
  disconnectHint,
}: {
  api: PluginAPI;
  engine: VaultSyncEngine;
  connection: React.ReactNode;
  disconnectHint: string;
}) {
  const sync = useEngineState(engine);
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [pollSeconds, setPollSeconds] = useState(60);
  const { busy, error, run } = useAction();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const deviceRequest = useRef(0);
  const loadDevices = useCallback(async () => {
    const request = ++deviceRequest.current;
    const next = await engine.listRemoteDevices().catch(() => null);
    if (request === deviceRequest.current) setDevices(next);
  }, [engine]);

  useEffect(() => {
    void loadDevices();
    void engine.getDeviceId().then(setLocalDeviceId);
    void api.storage.get<number>("pollIntervalSeconds").then((v) => v && setPollSeconds(v));
  }, [api, engine, loadDevices]);

  useEffect(() => {
    if (sync.status === "success") void loadDevices();
  }, [sync.lastSync, sync.status, loadDevices]);

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
          <Btn onClick={() => void run("sync", () => engine.syncNow())} busy={busy === "sync" || sync.status === "syncing"}>
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
                  engine.stopPoll();
                  engine.startPoll(clamped);
                });
              }}
            />
            <span className="text-sm text-(--t-text-dim)">seconds</span>
          </div>
        </div>
      </Card>

      {connection}

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
                    <p className="text-xs text-(--t-text-dim) truncate">{d.pushedAt ? `Last pushed ${new Date(d.pushedAt).toLocaleString()}` : "Last push time unknown"}</p>
                  </div>
                </div>
                {d.id !== localDeviceId && (
                  <Btn
                    small
                    variant="secondary"
                    busy={busy === `remove:${d.id}`}
                    disabled={!!busy}
                    onClick={() => void run(`remove:${d.id}`, async () => { await engine.removeRemoteDevice(d.id); await loadDevices(); })}
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
        <Hint>{disconnectHint}</Hint>
        <div className="flex items-center gap-2">
          {confirmDisconnect ? (
            <>
              <Btn variant="danger" busy={busy === "disconnect"} onClick={() => void run("disconnect", engine.disconnect)}>
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

export function SettingsShell({
  api,
  engine,
  icon,
  intro,
  wizard,
  connection,
  disconnectHint,
}: {
  api: PluginAPI;
  engine: VaultSyncEngine;
  icon: string;
  intro: string;
  wizard: (onDone: () => void) => React.ReactNode;
  connection: React.ReactNode;
  disconnectHint: string;
}) {
  const sync = useEngineState(engine);
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    void engine.isConfigured().then(setConfigured);
  }, [engine, sync.configured]);

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex items-center gap-2">
        <Icon icon={icon} width={20} className="text-(--t-text-primary)" />
        <h2 className="text-base font-semibold text-(--t-text-primary)">{api.i18n.t("settingsLabel")}</h2>
        {configured && <Dot tone={sync.status === "error" ? "error" : "connected"} />}
      </div>
      <p className="text-sm text-(--t-text-dim) -mt-4">{intro}</p>
      {configured === false && wizard(() => setConfigured(true))}
      {configured && (
        <ConfiguredView api={api} engine={engine} connection={connection} disconnectHint={disconnectHint} />
      )}
    </div>
  );
}
