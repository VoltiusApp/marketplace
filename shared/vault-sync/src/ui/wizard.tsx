import React, { useState } from "react";
import { Icon } from "@voltius/ui";
import type { PluginAPI } from "@voltius/plugin-types";
import type { ConfigValues, VaultState, VaultSyncEngine } from "../engine";
import type { VaultStore } from "../store";
import { Btn, Hint, LinkButton, SecretInput } from "./components";

export type StepState = "active" | "done" | "locked";

export function StepCard({
  n,
  title,
  state,
  summary,
  onChange,
  children,
}: {
  n: number;
  title: string;
  state: StepState;
  summary?: React.ReactNode;
  onChange?: () => void;
  children?: React.ReactNode;
}) {
  const badge =
    state === "done" ? (
      <span
        className="flex items-center justify-center w-5 h-5 rounded-full"
        style={{ background: "var(--t-status-connected)", color: "var(--t-bg-base)" }}
      >
        <Icon icon="lucide:check" width={12} />
      </span>
    ) : (
      <span
        className={`flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-semibold ${
          state === "active" ? "bg-(--t-accent) text-white" : "bg-(--t-bg-base) text-(--t-text-dim) border border-(--t-border)"
        }`}
      >
        {n}
      </span>
    );
  return (
    <div
      className={`flex flex-col gap-3 p-4 rounded-xl bg-(--t-bg-elevated) border ${
        state === "active" ? "border-(--t-border-hover)" : "border-(--t-border)"
      } ${state === "locked" ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-2">
        {badge}
        <p className="flex-1 text-sm font-medium text-(--t-text-primary)">{title}</p>
        {state === "done" && onChange && <LinkButton onClick={onChange}>Change</LinkButton>}
      </div>
      {state === "done" && summary && <div className="text-xs text-(--t-text-dim) pl-7">{summary}</div>}
      {state === "active" && <div className="flex flex-col gap-3">{children}</div>}
    </div>
  );
}

export function ChoiceTile({
  icon,
  title,
  description,
  onClick,
}: {
  icon: string;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 flex flex-col items-start gap-1 p-3 rounded-lg text-left bg-(--t-bg-base) border border-(--t-border) hover:border-(--t-border-hover) transition-colors"
      style={{ minWidth: "12rem" }}
    >
      <span className="flex items-center gap-2 text-sm font-medium text-(--t-text-primary)">
        <Icon icon={icon} width={15} />
        {title}
      </span>
      <span className="text-xs text-(--t-text-dim)">{description}</span>
    </button>
  );
}

export function ActionRow({ children, reason }: { children: React.ReactNode; reason: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {children}
      {reason && <span className="text-xs text-(--t-text-dim)">{reason}</span>}
    </div>
  );
}

export type Connection = { store: VaultStore; vault: VaultState; values: ConfigValues };

export function PassphraseStep({
  n,
  api,
  engine,
  connection,
  busy,
  run,
  existsHint,
  onDone,
}: {
  n: number;
  api: PluginAPI;
  engine: VaultSyncEngine;
  connection: Connection | null;
  busy: string | null;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
  existsHint: string;
  onDone: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const exists = connection?.vault === "exists";
  const reason = !passphrase
    ? "Enter a passphrase"
    : connection?.vault === "empty" && passphrase !== confirm
      ? "The passphrases do not match"
      : null;

  const finish = () =>
    run(exists ? "Linking…" : "Creating…", async () => {
      if (!connection) return;
      if (exists) await engine.linkVault(connection.store, passphrase, connection.values);
      else await engine.createVault(connection.store, passphrase, connection.values);
      engine.startPoll((await api.storage.get<number>("pollIntervalSeconds")) ?? 60);
      await engine.syncNow();
      onDone();
    });

  return (
    <StepCard n={n} title={exists ? "Unlock your vault" : "Choose an encryption passphrase"} state={connection ? "active" : "locked"}>
      {exists ? (
        <Hint>{existsHint}</Hint>
      ) : (
        <Hint>
          Your data is encrypted on this device with this passphrase before it leaves. You will need it on every
          device, and it cannot be recovered.
        </Hint>
      )}
      <SecretInput label="Passphrase" value={passphrase} onChange={setPassphrase} placeholder="Strong passphrase" />
      {connection?.vault === "empty" && (
        <SecretInput label="Confirm passphrase" value={confirm} onChange={setConfirm} placeholder="Type it again" />
      )}
      <ActionRow reason={busy ?? reason}>
        <Btn onClick={finish} disabled={!!reason} busy={!!busy}>
          {exists ? "Link vault" : "Create vault"}
        </Btn>
      </ActionRow>
    </StepCard>
  );
}
