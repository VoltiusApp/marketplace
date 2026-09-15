import React, { useCallback, useEffect, useState } from "react";
import { Icon } from "@voltius/ui";
import type { PluginAPI } from "@voltius/plugin-types";
import {
  disconnect,
  getCloudflareSyncState,
  isConfigured,
  linkExistingVault,
  setupNewVault,
  startPoll,
  stopPoll,
  syncNow,
  getDeviceId,
  removeRemoteDevice,
} from "./sync-engine";
import { WorkerApiError, getHealth, getManifest, type WorkerDevice } from "./worker-api";
import {
  CloudflareDeployError,
  DEFAULT_BUCKET_NAME,
  DEFAULT_WORKER_NAME,
  DEPLOY_TO_CLOUDFLARE_URL,
  deployWorker,
  generateSyncToken,
} from "./cloudflare-deploy";

function Btn({
  children,
  onClick,
  disabled,
  variant = "primary",
  small,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
  small?: boolean;
}) {
  const base =
    "rounded-lg font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default";
  const size = small ? "px-3 py-1 text-xs" : "px-4 py-2 text-sm";
  const colors =
    variant === "primary"
      ? "bg-(--t-accent) text-white hover:bg-(--t-accent-hover)"
      : variant === "danger"
        ? "bg-transparent border border-(--t-status-error) text-(--t-status-error) hover:bg-[color-mix(in_srgb,var(--t-status-error)_10%,transparent)]"
        : "bg-(--t-bg-elevated) border border-(--t-border) text-(--t-text-muted) hover:border-(--t-border-hover)";
  return (
    <button className={`${base} ${size} ${colors}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-(--t-text-muted)">{label}</label>
      {children}
      {hint ? <p className="text-[11px] text-(--t-text-dim)">{hint}</p> : null}
    </div>
  );
}

function textInputClass() {
  return "form-input w-full px-3 py-2 rounded-lg text-sm outline-hidden bg-(--t-bg-input) border border-(--t-border) text-(--t-text-primary)";
}

export function createSettingsPage(api: PluginAPI) {
  return function CloudflareSyncSettingsPage() {
    const [workerUrl, setWorkerUrl] = useState("");
    const [token, setToken] = useState("");
    const [passphrase, setPassphrase] = useState("");
    const [pollSeconds, setPollSeconds] = useState(60);
    const [configured, setConfigured] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [deviceCount, setDeviceCount] = useState<number | null>(null);
    const [devices, setDevices] = useState<WorkerDevice[]>([]);
    const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
    const [cfAccountId, setCfAccountId] = useState("");
    const [cfApiToken, setCfApiToken] = useState(""); // React state only — not persisted
    const [cfWorkerName, setCfWorkerName] = useState(DEFAULT_WORKER_NAME);
    const [cfBucketName, setCfBucketName] = useState(DEFAULT_BUCKET_NAME);
    const [deployBusy, setDeployBusy] = useState(false);

    // Only reads status: the connection inputs stay as typed until Create vault / Link existing
    // validates and persists them.
    const refresh = useCallback(async () => {
      const [url, tok, cfg] = await Promise.all([
        api.storage.get<string>("workerUrl"),
        api.vault.get("syncToken"),
        isConfigured(),
      ]);
      setConfigured(cfg);
      const localId = await getDeviceId();
      setLocalDeviceId(localId);
      if (cfg && url && tok) {
        try {
          const manifest = await getManifest(api.http, url, tok);
          setDeviceCount(manifest.devices.length);
          setDevices(manifest.devices);
        } catch {
          setDeviceCount(null);
          setDevices([]);
        }
      } else {
        setDeviceCount(null);
        setDevices([]);
      }
    }, [api]);

    useEffect(() => {
      void (async () => {
        const [url, tok, pass, poll, accountId, workerName, bucketName] = await Promise.all([
          api.storage.get<string>("workerUrl"),
          api.vault.get("syncToken"),
          api.vault.get("passphrase"),
          api.storage.get<number>("pollIntervalSeconds"),
          api.storage.get<string>("cfAccountId"),
          api.storage.get<string>("cfWorkerName"),
          api.storage.get<string>("cfBucketName"),
        ]);
        setWorkerUrl(url ?? "");
        setToken(tok ?? "");
        setPassphrase(pass ?? "");
        setPollSeconds(poll ?? 60);
        setCfAccountId(accountId ?? "");
        setCfWorkerName(workerName || DEFAULT_WORKER_NAME);
        setCfBucketName(bucketName || DEFAULT_BUCKET_NAME);
      })();
      void refresh();
    }, [refresh]);

    async function run(action: () => Promise<void>, okMsg: string) {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        await action();
        setMessage(okMsg);
        await refresh();
      } catch (err) {
        const msg =
          err instanceof WorkerApiError || err instanceof CloudflareDeployError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        setError(msg);
      } finally {
        setBusy(false);
      }
    }

    const syncState = getCloudflareSyncState();

    return (
      <div className="flex flex-col gap-6 p-4 max-w-xl">
        <div className="flex items-start gap-3">
          <Icon icon="lucide:cloud" width={22} className="text-(--t-text-primary) mt-0.5" />
          <div>
            <h2 className="text-lg font-semibold text-(--t-text-primary)">
              {api.i18n.t("settingsLabel")}
            </h2>
            <p className="text-sm text-(--t-text-muted)">
              Sync encrypted vault blobs to your own Cloudflare Worker + R2. The Worker only
              sees ciphertext. Use a passphrase that is{" "}
              <strong className="font-medium">not</strong> your sync token.
            </p>
          </div>
        </div>

        <section className="flex flex-col gap-2 rounded-lg border border-(--t-border) bg-(--t-bg-elevated) px-3 py-3">
          <h3 className="text-sm font-semibold text-(--t-text-primary)">
            Why Cloudflare Sync instead of Gist?
          </h3>
          <p className="text-[11px] text-(--t-text-dim)">
            Gist Sync is great when you already live on GitHub. Prefer this when you want your own
            cloud:
          </p>
          <ul className="list-disc pl-4 text-sm text-(--t-text-muted) space-y-1">
            <li>
              <strong className="font-medium text-(--t-text-primary)">You own the store</strong> —
              ciphertext lives in your R2 bucket, not on GitHub Gists.
            </li>
            <li>
              <strong className="font-medium text-(--t-text-primary)">No GitHub PAT</strong> — no
              gist scopes or GitHub account required for sync.
            </li>
            <li>
              <strong className="font-medium text-(--t-text-primary)">Built for objects</strong> —
              R2 is object storage (limits suited to vault blobs), not a gist file API.
            </li>
            <li>
              <strong className="font-medium text-(--t-text-primary)">Deploy from Voltius</strong> —
              create Worker + bucket + sync token from Settings without leaving the app.
            </li>
            <li>
              <strong className="font-medium text-(--t-text-primary)">Same E2EE model</strong> —
              passphrase stays on-device; Worker sees ciphertext only (like Gist Sync).
            </li>
          </ul>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-(--t-text-primary)">Deploy Worker</h3>
          <p className="text-xs text-(--t-text-dim)">
            Deploy the sync Worker into your Cloudflare account from here (no Wrangler required).
            API token stays in memory only. After deploy, use Create vault / Link below — deploy alone
            does not mark the vault configured.
          </p>
          <Field
            label="Cloudflare Account ID"
            hint="Dashboard → Workers & Pages → Account ID (right sidebar)"
          >
            <input
              className={textInputClass()}
              value={cfAccountId}
              onChange={(e) => {
                setCfAccountId(e.target.value);
                void api.storage.set("cfAccountId", e.target.value.trim());
              }}
              placeholder="32-char hex account id"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Cloudflare API token"
            hint="Permissions: Workers Scripts Edit, Workers R2 Storage Edit, Account Settings Read. Not saved."
          >
            <input
              type="password"
              className={textInputClass()}
              value={cfApiToken}
              onChange={(e) => setCfApiToken(e.target.value)}
              placeholder="API token (kept in memory only)"
              autoComplete="off"
            />
          </Field>
          <Field label="Worker name" hint={`Default: ${DEFAULT_WORKER_NAME}`}>
            <input
              className={textInputClass()}
              value={cfWorkerName}
              onChange={(e) => {
                setCfWorkerName(e.target.value);
                void api.storage.set("cfWorkerName", e.target.value.trim() || DEFAULT_WORKER_NAME);
              }}
              placeholder={DEFAULT_WORKER_NAME}
            />
          </Field>
          <Field label="R2 bucket name" hint={`Default: ${DEFAULT_BUCKET_NAME} (created if missing)`}>
            <input
              className={textInputClass()}
              value={cfBucketName}
              onChange={(e) => {
                setCfBucketName(e.target.value);
                void api.storage.set("cfBucketName", e.target.value.trim() || DEFAULT_BUCKET_NAME);
              }}
              placeholder={DEFAULT_BUCKET_NAME}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Btn
              variant="secondary"
              disabled={busy || deployBusy}
              onClick={() => {
                setToken(generateSyncToken());
                api.notifications.toast("Generated sync token (saved when you create or link a vault)", {
                  severity: "success",
                });
              }}
            >
              Generate sync token
            </Btn>
            <Btn
              disabled={
                busy ||
                deployBusy ||
                !cfAccountId.trim() ||
                !cfApiToken.trim() ||
                !token.trim()
              }
              onClick={() =>
                void (async () => {
                  setDeployBusy(true);
                  setError(null);
                  setMessage(null);
                  try {
                    const result = await deployWorker(api.http, {
                      accountId: cfAccountId,
                      apiToken: cfApiToken,
                      workerName: cfWorkerName,
                      bucketName: cfBucketName,
                      syncToken: token,
                    });
                    if (result.workerUrl) {
                      setWorkerUrl(result.workerUrl);
                      setMessage(
                        `Worker deployed: ${result.workerUrl}. Enter a passphrase, then Create vault or Link existing.`,
                      );
                      api.notifications.toast("Worker deployed", { severity: "success" });
                    } else {
                      setMessage(
                        "Worker script and SYNC_TOKEN deployed, but workers.dev subdomain could not be resolved (need Account Settings Read). Paste the Worker URL from the Cloudflare dashboard into Worker URL below.",
                      );
                      api.notifications.toast("Deployed — paste Worker URL manually", {
                        severity: "warning",
                      });
                    }
                  } catch (err) {
                    const msg =
                      err instanceof CloudflareDeployError || err instanceof Error
                        ? err.message
                        : String(err);
                    setError(msg);
                    api.notifications.toast("Deploy failed", { severity: "error" });
                  } finally {
                    setDeployBusy(false);
                  }
                })()
              }
            >
              {deployBusy ? "Deploying…" : "Deploy Worker"}
            </Btn>
            <Btn
              variant="secondary"
              disabled={busy || deployBusy}
              onClick={() =>
                void (async () => {
                  try {
                    await navigator.clipboard.writeText(DEPLOY_TO_CLOUDFLARE_URL);
                    api.notifications.toast("Deploy-to-Cloudflare URL copied", { severity: "success" });
                  } catch {
                    setMessage(`Copy this URL: ${DEPLOY_TO_CLOUDFLARE_URL}`);
                    api.notifications.toast("Could not access clipboard — URL shown below", {
                      severity: "info",
                    });
                  }
                })()
              }
            >
              Copy Deploy-to-Cloudflare URL
            </Btn>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-(--t-text-primary)">Connection</h3>
          <p className="text-xs text-(--t-text-dim)">
            These values are saved only when Create vault or Link existing succeeds.
          </p>
          <Field label="Worker URL" hint="Example: https://voltius-sync.example.workers.dev">
            <input
              className={textInputClass()}
              value={workerUrl}
              onChange={(e) => setWorkerUrl(e.target.value)}
              placeholder="https://your-worker.workers.dev"
            />
          </Field>
          <Field label="Sync token" hint="Bearer token configured as SYNC_TOKEN on the Worker">
            <input
              type="password"
              className={textInputClass()}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Long random secret"
            />
          </Field>
          <Field
            label="Encryption passphrase"
            hint="Required. Derives the vault encryption key. Never reuse the sync token."
          >
            <input
              type="password"
              className={textInputClass()}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Strong passphrase"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Btn
              disabled={busy || !workerUrl || !token || !passphrase}
              onClick={() =>
                void run(async () => {
                  try {
                    await setupNewVault(workerUrl, token, passphrase);
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (!msg.includes("already exists")) throw err;
                    const ok = window.confirm(
                      "A remote vault already exists on this Worker. Overwrite it? This replaces the remote salt/manifest and can make old device blobs undecryptable with a new passphrase.",
                    );
                    if (!ok) throw new Error("Create vault cancelled");
                    await setupNewVault(workerUrl, token, passphrase, { overwrite: true });
                  }
                  const interval =
                    (await api.storage.get<number>("pollIntervalSeconds")) ?? pollSeconds ?? 60;
                  stopPoll();
                  startPoll(interval);
                  await syncNow({ showProgress: false });
                }, "Created remote vault and uploaded this device")
              }
            >
              Create vault
            </Btn>
            <Btn
              variant="secondary"
              disabled={busy || !workerUrl || !token || !passphrase}
              onClick={() =>
                void run(async () => {
                  await linkExistingVault(workerUrl, token, passphrase);
                  const interval =
                    (await api.storage.get<number>("pollIntervalSeconds")) ?? pollSeconds ?? 60;
                  stopPoll();
                  startPoll(interval);
                  await syncNow({ showProgress: true });
                }, "Linked existing vault")
              }
            >
              Link existing
            </Btn>
            <Btn
              variant="secondary"
              disabled={busy || !workerUrl}
              onClick={() =>
                void run(async () => {
                  const health = await getHealth(api.http, workerUrl);
                  if (!health.ok) throw new Error("Worker health check failed");
                }, "Worker health OK")
              }
            >
              Test health
            </Btn>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-(--t-text-primary)">Sync</h3>
          <div className="text-sm text-(--t-text-muted)">
            Status: <span className="text-(--t-text-primary)">{syncState.status}</span>
            {configured ? " · configured" : " · not configured"}
            {deviceCount != null ? ` · ${deviceCount} device(s)` : ""}
            {syncState.lastSync
              ? ` · last ${syncState.lastSync.toLocaleString()}`
              : ""}
          </div>
          <Field label="Poll interval (seconds)">
            <input
              type="number"
              min={10}
              max={3600}
              className={textInputClass()}
              value={pollSeconds}
              onChange={(e) => setPollSeconds(Number(e.target.value) || 60)}
              onBlur={() => {
                const clamped = Math.min(3600, Math.max(10, pollSeconds || 60));
                setPollSeconds(clamped);
                void api.storage.set("pollIntervalSeconds", clamped).then(() => {
                  if (configured) {
                    stopPoll();
                    startPoll(clamped);
                  }
                });
              }}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Btn
              disabled={busy || !configured}
              onClick={() => void run(() => syncNow({ showProgress: true }), "Sync finished")}
            >
              Sync now
            </Btn>
            <Btn
              variant="danger"
              disabled={busy || !configured}
              onClick={() => void run(() => disconnect(), "Disconnected")}
            >
              Disconnect
            </Btn>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-(--t-text-primary)">Remote devices</h3>
          {devices.length === 0 ? (
            <p className="text-sm text-(--t-text-dim)">No devices listed yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {devices.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-(--t-border) px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="text-(--t-text-primary) truncate">
                      {d.label || d.id}
                      {d.id === localDeviceId ? " (this device)" : ""}
                    </div>
                    <div className="text-[11px] text-(--t-text-dim) truncate">
                      {d.id} · {d.pushedAt}
                    </div>
                  </div>
                  {d.id !== localDeviceId ? (
                    <Btn
                      small
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => removeRemoteDevice(d.id),
                          `Removed device ${d.label || d.id}`,
                        )
                      }
                    >
                      Remove
                    </Btn>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {message ? (
          <p className="text-sm text-(--t-status-connected)">{message}</p>
        ) : null}
        {error ? <p className="text-sm text-(--t-status-error)">{error}</p> : null}

        <p className="text-[11px] text-(--t-text-dim)">
          <strong className="font-medium">Deploy Worker</strong> uploads the Worker bundled with this
          plugin (source: VoltiusApp/marketplace, cloudflare-sync/worker). The Deploy-to-Cloudflare URL
          deploys the upstream mrchatam/voltius-cloudflare-sync-worker repository instead.
        </p>
      </div>
    );
  };
}
