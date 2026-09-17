import React, { useEffect, useState } from "react";
import { Icon } from "@voltius/ui";
import type { PluginAPI } from "@voltius/plugin-types";
import {
  CLOUDFLARE_DASHBOARD_URL,
  CREATE_API_TOKEN_URL,
  DEFAULT_BUCKET_NAME,
  DEFAULT_WORKER_NAME,
  deployWorker,
  generateSyncToken,
} from "./cloudflare-deploy";
import type { VaultSyncEngine } from "../../shared/vault-sync/src/engine";
import { describeError } from "../../shared/vault-sync/src/describeError";
import {
  Btn,
  copyText,
  ErrorBanner,
  Hint,
  LinkButton,
  SecretInput,
  TextInput,
  openExternal,
  useAction,
} from "../../shared/vault-sync/src/ui/components";
import {
  ActionRow,
  ChoiceTile,
  PassphraseStep,
  StepCard,
  type Connection,
  type StepState,
} from "../../shared/vault-sync/src/ui/wizard";
import { getHealth, normalizeWorkerUrl } from "./worker-api";
import { WorkerStore } from "./worker-store";

type Mode = "deploy" | "existing";

const HEALTH_ATTEMPTS_AFTER_DEPLOY = 20;
const HEALTH_RETRY_MS = 3000;
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForWorker(api: PluginAPI, workerUrl: string, attempts: number): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      if ((await getHealth(api.http, workerUrl)).ok) return;
    } catch (err) {
      lastError = err;
    }
    if (i < attempts - 1) await sleep(HEALTH_RETRY_MS);
  }
  throw new Error(`Could not reach the Worker at ${workerUrl}. ${lastError ? describeError(lastError) : ""}`.trim());
}

export function SetupWizard({ api, engine, onDone }: { api: PluginAPI; engine: VaultSyncEngine; onDone: () => void }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [connectedUrl, setConnectedUrl] = useState("");
  const { busy, setBusy, error, setError, run } = useAction();

  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [workerName, setWorkerName] = useState(DEFAULT_WORKER_NAME);
  const [bucketName, setBucketName] = useState(DEFAULT_BUCKET_NAME);
  const [deployedToken, setDeployedToken] = useState<string | null>(null);

  const [workerUrl, setWorkerUrl] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => {
    void Promise.all([
      api.storage.get<string>("cfAccountId"),
      api.storage.get<string>("cfWorkerName"),
      api.storage.get<string>("cfBucketName"),
    ]).then(([id, name, bucket]) => {
      if (id) setAccountId(id);
      if (name) setWorkerName(name);
      if (bucket) setBucketName(bucket);
    });
  }, [api]);

  async function connect(url: string, syncToken: string, healthAttempts: number) {
    const normalized = normalizeWorkerUrl(url);
    await waitForWorker(api, normalized, healthAttempts);
    const store = new WorkerStore(api.http, normalized, syncToken);
    const vault = await engine.detectVault(store);
    setConnectedUrl(normalized);
    setConnection({ store, vault, values: { storage: { workerUrl: normalized }, vault: { syncToken } } });
  }

  const deploy = () =>
    run("Deploying…", async () => {
      await Promise.all([
        api.storage.set("cfAccountId", accountId.trim()),
        api.storage.set("cfWorkerName", workerName.trim() || DEFAULT_WORKER_NAME),
        api.storage.set("cfBucketName", bucketName.trim() || DEFAULT_BUCKET_NAME),
      ]);
      const syncToken = generateSyncToken();
      const result = await deployWorker(api.http, { accountId, apiToken, workerName, bucketName, syncToken });
      setDeployedToken(syncToken);
      setToken(syncToken);
      if (!result.workerUrl) return;
      setWorkerUrl(result.workerUrl);
      setBusy("Waiting for the Worker to come online…");
      await connect(result.workerUrl, syncToken, HEALTH_ATTEMPTS_AFTER_DEPLOY);
    });

  const resetConnection = () => {
    setConnection(null);
    setError(null);
  };

  const step1: StepState = mode ? "done" : "active";
  const step2: StepState = !mode ? "locked" : connection ? "done" : "active";

  const deployReason = !accountId.trim()
    ? "Enter your Account ID"
    : !ACCOUNT_ID_RE.test(accountId.trim())
      ? "The Account ID is 32 letters and digits"
      : !apiToken.trim()
        ? "Enter an API token"
        : null;
  const connectReason = !workerUrl.trim() ? "Enter the Worker URL" : !token.trim() ? "Enter the sync token" : null;

  return (
    <div className="flex flex-col gap-3">
      {error && <ErrorBanner message={error} />}
      <StepCard
        n={1}
        title="Where is your sync Worker?"
        state={step1}
        summary={mode === "deploy" ? "Deploy a new Worker to my Cloudflare account" : "Use a Worker I already have"}
        onChange={busy ? undefined : () => {
          setMode(null);
          setDeployedToken(null);
          setToken("");
          setWorkerUrl("");
          resetConnection();
        }}
      >
        <div className="flex flex-wrap gap-2">
          <ChoiceTile
            icon="lucide:rocket"
            title="Deploy one for me"
            description="Recommended. Voltius creates the Worker and its R2 bucket in your Cloudflare account."
            onClick={() => setMode("deploy")}
          />
          <ChoiceTile
            icon="lucide:link"
            title="I already have one"
            description="You set Cloudflare Sync up on another device, or deployed the Worker yourself."
            onClick={() => setMode("existing")}
          />
        </div>
      </StepCard>

      <StepCard
        n={2}
        title={mode === "existing" ? "Connect to your Worker" : "Deploy the Worker"}
        state={step2}
        summary={
          connection && (
            <div className="flex flex-col gap-1">
              <span className="font-mono">{connectedUrl}</span>
              {deployedToken && (
                <span>
                  Sync token generated.{" "}
                  <LinkButton
                    onClick={() => {
                      void copyText(deployedToken).then(() =>
                        api.notifications.toast("Sync token copied", { severity: "success" }),
                      );
                    }}
                  >
                    Copy it
                  </LinkButton>{" "}
                  to set up your other devices.
                </span>
              )}
            </div>
          )
        }
        onChange={busy ? undefined : resetConnection}
      >
        {mode === "deploy" && !deployedToken && (
          <>
            <TextInput
              label="Cloudflare Account ID"
              value={accountId}
              onChange={setAccountId}
              placeholder="32 letters and digits"
              hint={
                <>
                  In the <LinkButton onClick={() => openExternal(CLOUDFLARE_DASHBOARD_URL)}>Cloudflare dashboard</LinkButton>,
                  press Ctrl+K (⌘K on macOS), search <span className="font-medium">Account ID</span> and select it to
                  copy it.
                </>
              }
            />
            <SecretInput
              label="Cloudflare API token"
              value={apiToken}
              onChange={setApiToken}
              placeholder="Paste the token"
              hint={
                <>
                  <LinkButton onClick={() => openExternal(CREATE_API_TOKEN_URL)}>Create a token</LinkButton> with the
                  permissions already selected, then choose Continue to summary → Create Token. Used once for the
                  deploy and never saved.
                </>
              }
            />
            <button
              type="button"
              className="flex items-center gap-1 self-start text-xs text-(--t-text-dim) hover:text-(--t-text-muted)"
              onClick={() => setShowAdvanced((s) => !s)}
            >
              <Icon icon={showAdvanced ? "lucide:chevron-down" : "lucide:chevron-right"} width={12} />
              Advanced
            </button>
            {showAdvanced && (
              <div className="flex flex-col gap-3 border-l border-(--t-border)" style={{ paddingLeft: "1rem" }}>
                <TextInput label="Worker name" value={workerName} onChange={setWorkerName} placeholder={DEFAULT_WORKER_NAME} />
                <TextInput
                  label="R2 bucket name"
                  value={bucketName}
                  onChange={setBucketName}
                  placeholder={DEFAULT_BUCKET_NAME}
                  hint="Created if it does not exist."
                />
              </div>
            )}
            <ActionRow reason={busy ?? deployReason}>
              <Btn onClick={deploy} disabled={!!deployReason} busy={!!busy}>
                Deploy Worker
              </Btn>
            </ActionRow>
          </>
        )}

        {(mode === "existing" || deployedToken) && (
          <>
            {deployedToken && (
              <Hint>
                The Worker is deployed with a new sync token. Paste its address to continue: in the{" "}
                <LinkButton onClick={() => openExternal(CLOUDFLARE_DASHBOARD_URL)}>Cloudflare dashboard</LinkButton>, open
                Workers &amp; Pages → {workerName.trim() || DEFAULT_WORKER_NAME} and copy the workers.dev URL.
              </Hint>
            )}
            <TextInput
              label="Worker URL"
              value={workerUrl}
              onChange={setWorkerUrl}
              placeholder="https://voltius-cloudflare-sync.<your-subdomain>.workers.dev"
              hint={mode === "existing" ? "Shown under Settings → Cloudflare Sync on a device that is already set up." : undefined}
            />
            {mode === "existing" && (
              <SecretInput
                label="Sync token"
                value={token}
                onChange={setToken}
                placeholder="The Worker's SYNC_TOKEN"
                hint="Copy it from a device that is already set up, or use the SYNC_TOKEN you set when deploying."
              />
            )}
            <ActionRow reason={busy ?? connectReason}>
              <Btn
                onClick={() => run("Connecting…", () => connect(workerUrl, token, 1))}
                disabled={!!connectReason}
                busy={!!busy}
              >
                Connect
              </Btn>
            </ActionRow>
          </>
        )}
      </StepCard>

      <PassphraseStep
        key={connection ? "connected" : "none"}
        n={3}
        api={api}
        engine={engine}
        connection={connection}
        busy={busy}
        run={run}
        existsHint="This Worker already holds a synced vault. Enter the passphrase you chose when you created it."
        onDone={onDone}
      />
    </div>
  );
}
