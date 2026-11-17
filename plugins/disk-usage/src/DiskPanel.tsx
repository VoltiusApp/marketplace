import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FC, type ReactNode } from "react";
import { Icon, MobileScreenHeader, useActiveSession, useSessionById, useT, writeClipboard } from "@voltius/ui";
import type { MobileScreenProps, PluginAPI, PluginSession } from "@voltius/plugin-types";
import { formatKb, normalizePath, sizeOf, type DirNode } from "./scan";
import { squarify } from "./treemap";
import type { Files, Scan, ScanStore } from "./store";

const MAX_ROWS = 100;
const MAX_TILES = 40;

interface Density {
  touch: boolean;
  row: number;
  text: number;
  small: number;
  map: number;
  field: number;
  icon: number;
}

const DESKTOP: Density = { touch: false, row: 26, text: 12, small: 11, map: 150, field: 12, icon: 13 };
const TOUCH: Density = { touch: true, row: 48, text: 15, small: 13, map: 180, field: 16, icon: 18 };

interface Entry {
  name: string;
  path: string;
  kb: number;
  dir: DirNode | null;
}

const muted: CSSProperties = { color: "var(--t-text-muted)" };

function iconButton(d: Density): CSSProperties {
  const side = d.touch ? 40 : "auto";
  return { ...muted, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", width: side, height: side };
}

function Hint({ d, warn, children }: { d: Density; warn?: boolean; children: ReactNode }) {
  return <div style={{ color: warn ? "var(--t-status-warning)" : "var(--t-text-muted)", fontSize: d.small, padding: "4px" }}>{children}</div>;
}

function entriesOf(node: DirNode, files: Files | undefined): Entry[] {
  const dirs: Entry[] = [...node.children.values()].map((d) => ({ name: d.name, path: d.path, kb: sizeOf(d), dir: d }));
  const plain: Entry[] = Array.isArray(files) ? files.map((f) => ({ ...f, dir: null })) : [];
  return [...dirs, ...plain].sort((a, b) => b.kb - a.kb);
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function Treemap({ entries, total, onOpen, height }: { entries: Entry[]; total: number; onOpen: (e: Entry) => void; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const shown = entries.slice(0, MAX_TILES);
  const rest = Math.max(0, total - shown.reduce((a, e) => a + e.kb, 0));
  const weighted = shown.map((e) => ({ item: e as Entry | null, weight: e.kb }));
  if (rest > 0) weighted.push({ item: null, weight: rest });
  weighted.sort((a, b) => b.weight - a.weight);
  const tiles = squarify(weighted, { x: 0, y: 0, w: width, h: height });
  return (
    <div ref={ref} style={{ position: "relative", height, borderRadius: 6, overflow: "hidden", background: "var(--t-bg-card)" }}>
      {tiles.map((tile, i) => {
        const e = tile.item;
        const share = e ? 18 + Math.round(42 * Math.sqrt(e.kb / Math.max(1, total))) : 0;
        const background = !e
          ? "var(--t-bg-elevated)"
          : e.dir
            ? `color-mix(in srgb, var(--t-accent) ${share}%, var(--t-bg-card))`
            : `color-mix(in srgb, var(--t-text-muted) ${Math.round(share / 2)}%, var(--t-bg-card))`;
        return (
          <button
            key={e?.path ?? `rest-${i}`}
            type="button"
            title={e ? `${e.name} — ${formatKb(e.kb)}` : formatKb(rest)}
            disabled={!e?.dir}
            onClick={() => e && onOpen(e)}
            style={{
              position: "absolute",
              left: tile.x,
              top: tile.y,
              width: tile.w,
              height: tile.h,
              background,
              border: "1px solid var(--t-bg-base)",
              padding: "2px 4px",
              textAlign: "left",
              overflow: "hidden",
              cursor: e?.dir ? "pointer" : "default",
              color: "var(--t-text-primary)",
              fontSize: 10,
              lineHeight: "13px",
            }}
          >
            {e && tile.w > 46 && tile.h > 16 && (
              <>
                <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 500 }}>{e.name}</div>
                {tile.h > 30 && <div style={{ ...muted, whiteSpace: "nowrap" }}>{formatKb(e.kb)}</div>}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Breadcrumb({ root, current, onOpen, d }: { root: string; current: string; onOpen: (p: string) => void; d: Density }) {
  const rel = current === root ? [] : current.slice(root === "/" ? 1 : root.length + 1).split("/");
  const crumbs = [{ label: root, path: root }];
  rel.forEach((name, i) => {
    const base = crumbs[i].path;
    crumbs.push({ label: name, path: base === "/" ? `/${name}` : `${base}/${name}` });
  });
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2, fontSize: d.small, minWidth: 0 }}>
      {crumbs.map((c, i) => (
        <span key={c.path} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          {i > 0 && <span style={{ display: "inline-flex", ...muted }}><Icon icon="lucide:chevron-right" width={10} /></span>}
          <button
            type="button"
            onClick={() => onOpen(c.path)}
            style={{ color: i === crumbs.length - 1 ? "var(--t-text-primary)" : "var(--t-text-muted)", fontWeight: i === crumbs.length - 1 ? 600 : 400, padding: d.touch ? "8px 2px" : 0 }}
          >
            {c.label}
          </button>
        </span>
      ))}
    </div>
  );
}

function Row({ entry, total, onOpen, t, d }: { entry: Entry; total: number; onOpen: (e: Entry) => void; t: PluginAPI["i18n"]["t"]; d: Density }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const pct = total > 0 ? (entry.kb / total) * 100 : 0;
  const copy = () => {
    writeClipboard(entry.path).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => setFailed(true),
    );
  };
  return (
    <div className="du-row" style={{ display: "flex", alignItems: "center", gap: d.touch ? 10 : 6, height: d.row, padding: "0 4px", borderRadius: 4, fontSize: d.text }}>
      <button
        type="button"
        disabled={!entry.dir}
        onClick={() => onOpen(entry)}
        style={{ display: "flex", alignItems: "center", gap: d.touch ? 10 : 6, flex: 1, minWidth: 0, alignSelf: "stretch", textAlign: "left", cursor: entry.dir ? "pointer" : "default", color: "var(--t-text-primary)" }}
      >
        <span style={{ display: "inline-flex", flexShrink: 0, color: entry.dir ? "var(--t-accent)" : "var(--t-text-muted)" }}><Icon icon={entry.dir ? "lucide:folder" : "lucide:file"} width={d.icon} /></span>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
      </button>
      <div style={{ width: 44, height: 4, borderRadius: 2, background: "var(--t-bg-elevated)", flexShrink: 0 }}>
        <div style={{ width: `${Math.max(pct, entry.kb > 0 ? 2 : 0)}%`, height: "100%", borderRadius: 2, background: entry.dir ? "var(--t-accent)" : "var(--t-text-muted)" }} />
      </div>
      <span style={{ width: d.touch ? 72 : 58, textAlign: "right", fontVariantNumeric: "tabular-nums", flexShrink: 0, ...muted }}>{formatKb(entry.kb)}</span>
      <button
        type="button"
        className="du-copy"
        title={failed ? t("copyFailed", { path: entry.path }) : copied ? t("copied") : t("copyPath")}
        aria-label={t("copyPath")}
        onClick={copy}
        style={iconButton(d)}
      >
        <Icon icon={copied ? "lucide:check" : "lucide:copy"} width={d.touch ? 16 : 12} />
      </button>
    </div>
  );
}

function Status({ scan, now, t }: { scan: Scan; now: number; t: PluginAPI["i18n"]["t"] }) {
  const count = scan.tree.dirs.toLocaleString();
  if (scan.phase === "scanning") return <span>{t("scanning", { count, elapsed: elapsed(now - scan.startedAt) })}</span>;
  if (scan.phase === "cancelled") return <span>{t("cancelled", { count })}</span>;
  if (scan.phase === "error") {
    // 127: the shell could not find a command (du, find or nice).
    const noDu = scan.exitCode === 127 || /is not recognized/i.test(scan.lastError);
    const message = scan.lastError === "windowsPath" ? t("windowsPath") : noDu ? t("noDu") : t("failed", { error: scan.lastError });
    return <span style={{ color: "var(--t-status-error)" }}>{message}</span>;
  }
  return (
    <span>
      {t("scanned", { size: formatKb(sizeOf(scan.tree.root)), count, elapsed: elapsed((scan.finishedAt ?? now) - scan.startedAt) })}
      {scan.unreadable > 0 && (
        <span title={scan.lastError} style={{ color: "var(--t-status-warning)" }}>
          {" · "}
          {t("unreadable", { count: scan.unreadable })}
        </span>
      )}
    </span>
  );
}

function SessionDisk({ api, store, session, d }: { api: PluginAPI; store: ScanStore; session: PluginSession; d: Density }) {
  const t = useT(api);
  useSyncExternalStore(store.subscribe, store.getVersion);
  const scan = store.get(session.id);
  const [path, setPath] = useState(scan?.tree.root.path ?? "/");
  const now = useNow(scan?.phase === "scanning");
  useEffect(() => setPath(store.get(session.id)?.tree.root.path ?? "/"), [session.id, store]);

  const node = scan ? scan.tree.find(scan.current) ?? scan.tree.root : null;
  const files = scan && node ? store.filesFor(session.id, node.path) : undefined;
  const entries = useMemo(() => (node ? entriesOf(node, files) : []), [node, files, store.version]);
  const total = node ? Math.max(sizeOf(node), entries.reduce((a, e) => a + e.kb, 0)) : 0;
  const open = (e: Entry) => e.dir && store.open(session.id, e.path);
  const scanning = scan?.phase === "scanning";

  const goHome = async () => {
    const home = await store.homeOf(session.id);
    if (home) setPath(home);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: d.touch ? 12 : 8, padding: d.touch ? "12px 16px" : "8px 10px", fontSize: d.text, color: "var(--t-text-primary)" }}>
      {!d.touch && <style>{`.du-row:hover{background:var(--t-bg-elevated)} .du-row .du-copy{opacity:0} .du-row:hover .du-copy{opacity:1}`}</style>}
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          store.start(session.id, normalizePath(path));
        }}
        style={{ display: "flex", gap: 6 }}
      >
        <div style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0, height: d.touch ? 44 : "auto", border: "1px solid var(--t-border)", borderRadius: d.touch ? 10 : 6, background: "var(--t-bg-base)" }}>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t("pathPlaceholder")}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            style={{ flex: 1, minWidth: 0, background: "transparent", border: 0, outline: "none", padding: d.touch ? "0 12px" : "4px 8px", fontSize: d.field, fontFamily: "var(--font-mono, monospace)", color: "var(--t-text-primary)" }}
          />
          <button type="button" title={t("home")} aria-label={t("home")} onClick={() => void goHome()} style={{ ...muted, padding: d.touch ? "0 12px" : "0 6px", alignSelf: "stretch" }}>
            <Icon icon="lucide:house" width={d.icon} />
          </button>
        </div>
        {scanning ? (
          <button
            type="button"
            onClick={() => store.cancel(session.id)}
            style={{ padding: d.touch ? "0 16px" : "4px 10px", borderRadius: d.touch ? 10 : 6, border: "1px solid var(--t-border)", color: "var(--t-text-primary)", fontSize: d.text }}
          >
            {t("cancel")}
          </button>
        ) : (
          <button type="submit" style={{ padding: d.touch ? "0 18px" : "4px 10px", borderRadius: d.touch ? 10 : 6, background: "var(--t-accent)", color: "var(--t-bg-base)", fontSize: d.text, fontWeight: 600 }}>
            {scan ? t("rescan") : t("scan")}
          </button>
        )}
      </form>

      {!scan && <p style={{ ...muted, margin: 0, lineHeight: 1.5 }}>{t("intro")}</p>}

      {scan && node && (
        <>
          <div style={{ ...muted, fontSize: d.small }}>
            <Status scan={scan} now={now} t={t} />
          </div>
          {entries.length > 0 && <Treemap entries={entries} total={total} onOpen={open} height={d.map} />}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              title={t("up")}
              aria-label={t("up")}
              disabled={node === scan.tree.root}
              onClick={() => store.open(session.id, node.path.slice(0, node.path.lastIndexOf("/")) || "/")}
              style={{ ...iconButton(d), opacity: node === scan.tree.root ? 0.4 : 1 }}
            >
              <Icon icon="lucide:arrow-up" width={d.icon} />
            </button>
            <Breadcrumb root={scan.tree.root.path} current={node.path} onOpen={(p) => store.open(session.id, p)} d={d} />
            <span style={{ marginLeft: "auto", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatKb(total)}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {entries.slice(0, MAX_ROWS).map((e) => (
              <Row key={e.path} entry={e} total={total} onOpen={open} t={t} d={d} />
            ))}
            {entries.length > MAX_ROWS && <Hint d={d}>{t("more", { count: entries.length - MAX_ROWS })}</Hint>}
            {files === "loading" && <Hint d={d}>{t("loadingFiles")}</Hint>}
            {files === "error" && <Hint d={d} warn>{t("filesFailed")}</Hint>}
            {entries.length === 0 && !scanning && files !== "loading" && <Hint d={d}>{t("empty")}</Hint>}
          </div>
        </>
      )}
    </div>
  );
}

function unavailable(t: PluginAPI["i18n"]["t"], session: PluginSession | null): string | null {
  if (!session) return t("noSession");
  if (session.type === "serial") return t("unsupported");
  if (session.status !== "connected") return t("notConnected");
  return null;
}

function Disk({ api, store, session, d }: { api: PluginAPI; store: ScanStore; session: PluginSession | null; d: Density }) {
  const message = unavailable(useT(api), session);
  if (message || !session) {
    return <p style={{ ...muted, margin: 0, padding: d.touch ? "16px" : "8px 10px", fontSize: d.text, lineHeight: 1.5 }}>{message}</p>;
  }
  return <SessionDisk key={session.id} api={api} store={store} session={session} d={d} />;
}

export function createDiskPanel(api: PluginAPI, store: ScanStore): FC {
  return function DiskPanel() {
    return <Disk api={api} store={store} session={useActiveSession(api)} d={DESKTOP} />;
  };
}

export function createMobileDiskScreen(api: PluginAPI, store: ScanStore): FC<MobileScreenProps> {
  return function MobileDiskScreen({ sessionId, onBack }) {
    const t = useT(api);
    const session = useSessionById(api, sessionId);
    return (
      <div style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", flexDirection: "column", background: "var(--t-bg-base)" }}>
        <MobileScreenHeader title={t("title")} subtitle={session?.connectionName} onBack={onBack} />
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
          <Disk api={api} store={store} session={session} d={TOUCH} />
        </div>
      </div>
    );
  };
}
