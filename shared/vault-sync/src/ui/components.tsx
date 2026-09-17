import React, { useState } from "react";
import { Icon } from "@voltius/ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { describeError } from "../describeError";

// A plain anchor is a no-op in the Tauri webview, so links go through the opener plugin.
export function openExternal(url: string): void {
  void openUrl(url).catch(() => {});
}

export async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}

export function Btn({
  children,
  onClick,
  disabled,
  variant = "primary",
  small,
  busy,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
  small?: boolean;
  busy?: boolean;
  title?: string;
}) {
  const base =
    "inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default";
  const size = small ? "px-3 py-1 text-xs" : "px-4 py-2 text-sm";
  const colors =
    variant === "primary"
      ? "bg-(--t-accent) text-white hover:bg-(--t-accent-hover)"
      : variant === "danger"
        ? "bg-transparent border border-(--t-status-error) text-(--t-status-error) hover:bg-[color-mix(in_srgb,var(--t-status-error)_10%,transparent)]"
        : "bg-(--t-bg-elevated) border border-(--t-border) text-(--t-text-muted) hover:border-(--t-border-hover)";
  return (
    <button className={`${base} ${size} ${colors}`} onClick={onClick} disabled={disabled || busy} title={title}>
      {busy && <Icon icon="lucide:loader-circle" width={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export function LinkButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-(--t-accent) hover:underline">
      {children}
    </button>
  );
}

export function Card({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 p-4 rounded-xl bg-(--t-bg-elevated) border border-(--t-border)">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-(--t-text-muted) uppercase tracking-wide">{title}</p>
        {aside}
      </div>
      {children}
    </div>
  );
}

const INPUT_CLASS =
  "form-input w-full px-3 py-2 rounded-lg text-sm outline-hidden bg-(--t-bg-input) border border-(--t-border) text-(--t-text-primary)";

function FieldShell({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-(--t-text-muted)">{label}</label>
      {children}
      {hint && <p className="text-xs text-(--t-text-dim)">{hint}</p>}
    </div>
  );
}

export function TextInput({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <FieldShell label={label} hint={hint}>
      <input
        className={INPUT_CLASS}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
    </FieldShell>
  );
}

export function SecretInput({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <FieldShell label={label} hint={hint}>
      <div className="relative flex items-center">
        <input
          type={show ? "text" : "password"}
          className={`${INPUT_CLASS} pr-9`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="absolute right-2 text-(--t-text-dim) hover:text-(--t-text-muted)"
          onClick={() => setShow((s) => !s)}
          tabIndex={-1}
          title={show ? "Hide" : "Show"}
        >
          <Icon icon={show ? "lucide:eye-off" : "lucide:eye"} width={14} />
        </button>
      </div>
    </FieldShell>
  );
}

export function Dot({ tone }: { tone: "connected" | "error" | "idle" }) {
  const color =
    tone === "connected" ? "var(--t-status-connected)" : tone === "error" ? "var(--t-status-error)" : "var(--t-text-dim)";
  return <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: color }} />;
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="px-3 py-2 rounded-lg text-sm text-(--t-status-error) border border-(--t-status-error) bg-[color-mix(in_srgb,var(--t-status-error)_8%,transparent)]">
      {message}
    </div>
  );
}

export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  }
  return { busy, setBusy, error, setError, run };
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-(--t-text-dim)">{children}</p>;
}
