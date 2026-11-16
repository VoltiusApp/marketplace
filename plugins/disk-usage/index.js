// src/i18n.ts
var messages = {
  en: {
    title: "Disk Usage",
    scan: "Scan",
    rescan: "Rescan",
    cancel: "Cancel",
    home: "Home folder",
    pathPlaceholder: "Folder to scan, e.g. /var",
    noSession: "Open an SSH or local terminal to scan its disk.",
    unsupported: "This session cannot run commands.",
    notConnected: "Waiting for the session to connect.",
    intro: "Scan a folder to see what takes up space. Scans stay on one filesystem and run at low priority.",
    scanning: "Scanning\u2026 {{count}} folders \xB7 {{elapsed}}",
    scanned: "{{size}} \xB7 {{count}} folders \xB7 took {{elapsed}}",
    cancelled: "Scan cancelled after {{count}} folders.",
    unreadable_one: "{{count}} folder could not be read",
    unreadable_other: "{{count}} folders could not be read",
    failed: "Scan failed: {{error}}",
    noDu: "This host has no POSIX `du` (Windows hosts are not supported yet).",
    empty: "Nothing here.",
    loadingFiles: "Listing files\u2026",
    filesFailed: "Could not list the files in this folder.",
    copyPath: "Copy path",
    copied: "Copied",
    copyFailed: "Could not copy. Path: {{path}}",
    up: "Up one level",
    more: "{{count}} smaller items"
  },
  fr: {
    title: "Espace disque",
    scan: "Analyser",
    rescan: "Relancer",
    cancel: "Annuler",
    home: "Dossier personnel",
    pathPlaceholder: "Dossier \xE0 analyser, ex. /var",
    noSession: "Ouvrez un terminal SSH ou local pour analyser son disque.",
    unsupported: "Cette session ne peut pas ex\xE9cuter de commandes.",
    notConnected: "En attente de la connexion de la session.",
    intro: "Analysez un dossier pour voir ce qui occupe l'espace. L'analyse reste sur un seul syst\xE8me de fichiers et tourne en basse priorit\xE9.",
    scanning: "Analyse\u2026 {{count}} dossiers \xB7 {{elapsed}}",
    scanned: "{{size}} \xB7 {{count}} dossiers \xB7 en {{elapsed}}",
    cancelled: "Analyse annul\xE9e apr\xE8s {{count}} dossiers.",
    unreadable_one: "{{count}} dossier illisible",
    unreadable_other: "{{count}} dossiers illisibles",
    failed: "\xC9chec de l'analyse : {{error}}",
    noDu: "Cet h\xF4te n'a pas de `du` POSIX (les h\xF4tes Windows ne sont pas encore pris en charge).",
    empty: "Rien ici.",
    loadingFiles: "Liste des fichiers\u2026",
    filesFailed: "Impossible de lister les fichiers de ce dossier.",
    copyPath: "Copier le chemin",
    copied: "Copi\xE9",
    copyFailed: "Copie impossible. Chemin : {{path}}",
    up: "Remonter d'un niveau",
    more: "{{count}} \xE9l\xE9ments plus petits"
  }
};

// src/DiskPanel.tsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon, MobileScreenHeader, useActiveSession, useSessionById, useT, writeClipboard } from "@voltius/ui";

// src/scan.ts
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function sh(script, ...args) {
  return `sh -c ${shellQuote(script)} sh ${args.map(shellQuote).join(" ")}`;
}
function scanCommand(root) {
  return sh(
    'if command -v ionice >/dev/null 2>&1; then exec nice -n 19 ionice -c3 du -xk -- "$1"; fi; exec nice -n 19 du -xk -- "$1"',
    root
  );
}
function filesCommand(dir) {
  return sh('find "$1" -maxdepth 1 -type f -exec du -k {} + 2>/dev/null', dir);
}
var HOME_COMMAND = sh('printf %s "$HOME"');
function normalizePath(p) {
  const trimmed = p.trim();
  if (trimmed === "" || trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}
function parseDuLine(line) {
  const tab = line.indexOf("	");
  if (tab <= 0) return null;
  const kb = Number(line.slice(0, tab));
  const path = line.slice(tab + 1);
  if (!Number.isFinite(kb) || path === "") return null;
  return { kb, path };
}
function basename(path) {
  return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
}
var DuTree = class {
  root;
  dirs = 0;
  constructor(rootPath) {
    const path = normalizePath(rootPath);
    this.root = { name: basename(path), path, kb: null, doneKb: 0, children: /* @__PURE__ */ new Map() };
  }
  /** Splits a du line's path below the root; anything outside it is ignored. */
  add(kb, rawPath) {
    const path = normalizePath(rawPath);
    const root = this.root.path;
    this.dirs += 1;
    if (path === root) {
      this.root.kb = kb;
      return;
    }
    const prefix = root === "/" ? "/" : `${root}/`;
    if (!path.startsWith(prefix)) return;
    let parent = this.root;
    let node = this.root;
    for (const name of path.slice(prefix.length).split("/")) {
      let child = node.children.get(name);
      if (!child) {
        const childPath = node.path === "/" ? `/${name}` : `${node.path}/${name}`;
        child = { name, path: childPath, kb: null, doneKb: 0, children: /* @__PURE__ */ new Map() };
        node.children.set(name, child);
      }
      parent = node;
      node = child;
    }
    if (node.kb === null) parent.doneKb += kb;
    node.kb = kb;
  }
  find(path) {
    const target = normalizePath(path);
    if (target === this.root.path) return this.root;
    const prefix = this.root.path === "/" ? "/" : `${this.root.path}/`;
    if (!target.startsWith(prefix)) return null;
    let node = this.root;
    for (const name of target.slice(prefix.length).split("/")) {
      node = node.children.get(name);
      if (!node) return null;
    }
    return node;
  }
};
function sizeOf(node) {
  if (node.kb !== null) return node.kb;
  let sum = node.doneKb;
  for (const child of node.children.values()) if (child.kb === null) sum += sizeOf(child);
  return sum;
}
function parseFiles(output) {
  const files = [];
  for (const line of output.split("\n")) {
    const parsed = parseDuLine(line);
    if (parsed) files.push({ name: basename(parsed.path), path: parsed.path, kb: parsed.kb });
  }
  return files;
}
function lineSplitter(onLine) {
  let rest = "";
  return {
    push(chunk) {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    flush() {
      if (rest) onLine(rest);
      rest = "";
    }
  };
}
function formatKb(kb) {
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = kb;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

// src/treemap.ts
function worst(row, side) {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max(side * side * max / (sum * sum), sum * sum / (side * side * min));
}
function squarify(items, bounds) {
  const total = items.reduce((a, i) => a + i.weight, 0);
  const positive = items.filter((i) => i.weight > 0);
  if (total <= 0 || bounds.w <= 0 || bounds.h <= 0) return [];
  const scale = bounds.w * bounds.h / total;
  const areas = positive.map((i) => i.weight * scale);
  const tiles = [];
  let free = { ...bounds };
  let start = 0;
  while (start < areas.length) {
    const side = Math.min(free.w, free.h);
    let end = start + 1;
    while (end < areas.length && worst(areas.slice(start, end + 1), side) <= worst(areas.slice(start, end), side)) {
      end += 1;
    }
    const row = areas.slice(start, end);
    const rowArea = row.reduce((a, b) => a + b, 0);
    const horizontal = free.w >= free.h;
    const thickness = rowArea / (horizontal ? free.h : free.w);
    let offset = 0;
    row.forEach((area, k) => {
      const length = area / thickness;
      tiles.push(
        horizontal ? { item: positive[start + k].item, x: free.x, y: free.y + offset, w: thickness, h: length } : { item: positive[start + k].item, x: free.x + offset, y: free.y, w: length, h: thickness }
      );
      offset += length;
    });
    free = horizontal ? { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h } : { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness };
    start = end;
  }
  return tiles;
}

// src/DiskPanel.tsx
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var MAX_ROWS = 100;
var MAX_TILES = 40;
var DESKTOP = { touch: false, row: 26, text: 12, small: 11, map: 150, field: 12, icon: 13 };
var TOUCH = { touch: true, row: 48, text: 15, small: 13, map: 180, field: 16, icon: 18 };
var muted = { color: "var(--t-text-muted)" };
function iconButton(d) {
  const side = d.touch ? 40 : "auto";
  return { ...muted, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", width: side, height: side };
}
function Hint({ d, warn, children }) {
  return /* @__PURE__ */ jsx("div", { style: { color: warn ? "var(--t-status-warning)" : "var(--t-text-muted)", fontSize: d.small, padding: "4px" }, children });
}
function entriesOf(node, files) {
  const dirs = [...node.children.values()].map((d) => ({ name: d.name, path: d.path, kb: sizeOf(d), dir: d }));
  const plain = Array.isArray(files) ? files.map((f) => ({ ...f, dir: null })) : [];
  return [...dirs, ...plain].sort((a, b) => b.kb - a.kb);
}
function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1e3));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1e3);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
function Treemap({ entries, total, onOpen, height }) {
  const ref = useRef(null);
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
  const weighted = shown.map((e) => ({ item: e, weight: e.kb }));
  if (rest > 0) weighted.push({ item: null, weight: rest });
  weighted.sort((a, b) => b.weight - a.weight);
  const tiles = squarify(weighted, { x: 0, y: 0, w: width, h: height });
  return /* @__PURE__ */ jsx("div", { ref, style: { position: "relative", height, borderRadius: 6, overflow: "hidden", background: "var(--t-bg-card)" }, children: tiles.map((tile, i) => {
    const e = tile.item;
    const share = e ? 18 + Math.round(42 * Math.sqrt(e.kb / Math.max(1, total))) : 0;
    const background = !e ? "var(--t-bg-elevated)" : e.dir ? `color-mix(in srgb, var(--t-accent) ${share}%, var(--t-bg-card))` : `color-mix(in srgb, var(--t-text-muted) ${Math.round(share / 2)}%, var(--t-bg-card))`;
    return /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        title: e ? `${e.name} \u2014 ${formatKb(e.kb)}` : formatKb(rest),
        disabled: !e?.dir,
        onClick: () => e && onOpen(e),
        style: {
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
          lineHeight: "13px"
        },
        children: e && tile.w > 46 && tile.h > 16 && /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx("div", { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 500 }, children: e.name }),
          tile.h > 30 && /* @__PURE__ */ jsx("div", { style: { ...muted, whiteSpace: "nowrap" }, children: formatKb(e.kb) })
        ] })
      },
      e?.path ?? `rest-${i}`
    );
  }) });
}
function Breadcrumb({ root, current, onOpen, d }) {
  const rel = current === root ? [] : current.slice(root === "/" ? 1 : root.length + 1).split("/");
  const crumbs = [{ label: root, path: root }];
  rel.forEach((name, i) => {
    const base = crumbs[i].path;
    crumbs.push({ label: name, path: base === "/" ? `/${name}` : `${base}/${name}` });
  });
  return /* @__PURE__ */ jsx("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2, fontSize: d.small, minWidth: 0 }, children: crumbs.map((c, i) => /* @__PURE__ */ jsxs("span", { style: { display: "inline-flex", alignItems: "center", gap: 2 }, children: [
    i > 0 && /* @__PURE__ */ jsx("span", { style: { display: "inline-flex", ...muted }, children: /* @__PURE__ */ jsx(Icon, { icon: "lucide:chevron-right", width: 10 }) }),
    /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: () => onOpen(c.path),
        style: { color: i === crumbs.length - 1 ? "var(--t-text-primary)" : "var(--t-text-muted)", fontWeight: i === crumbs.length - 1 ? 600 : 400, padding: d.touch ? "8px 2px" : 0 },
        children: c.label
      }
    )
  ] }, c.path)) });
}
function Row({ entry, total, onOpen, t, d }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const pct = total > 0 ? entry.kb / total * 100 : 0;
  const copy = () => {
    writeClipboard(entry.path).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => setFailed(true)
    );
  };
  return /* @__PURE__ */ jsxs("div", { className: "du-row", style: { display: "flex", alignItems: "center", gap: d.touch ? 10 : 6, height: d.row, padding: "0 4px", borderRadius: 4, fontSize: d.text }, children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        disabled: !entry.dir,
        onClick: () => onOpen(entry),
        style: { display: "flex", alignItems: "center", gap: d.touch ? 10 : 6, flex: 1, minWidth: 0, alignSelf: "stretch", textAlign: "left", cursor: entry.dir ? "pointer" : "default", color: "var(--t-text-primary)" },
        children: [
          /* @__PURE__ */ jsx("span", { style: { display: "inline-flex", flexShrink: 0, color: entry.dir ? "var(--t-accent)" : "var(--t-text-muted)" }, children: /* @__PURE__ */ jsx(Icon, { icon: entry.dir ? "lucide:folder" : "lucide:file", width: d.icon }) }),
          /* @__PURE__ */ jsx("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: entry.name })
        ]
      }
    ),
    /* @__PURE__ */ jsx("div", { style: { width: 44, height: 4, borderRadius: 2, background: "var(--t-bg-elevated)", flexShrink: 0 }, children: /* @__PURE__ */ jsx("div", { style: { width: `${Math.max(pct, entry.kb > 0 ? 2 : 0)}%`, height: "100%", borderRadius: 2, background: entry.dir ? "var(--t-accent)" : "var(--t-text-muted)" } }) }),
    /* @__PURE__ */ jsx("span", { style: { width: d.touch ? 72 : 58, textAlign: "right", fontVariantNumeric: "tabular-nums", flexShrink: 0, ...muted }, children: formatKb(entry.kb) }),
    /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        className: "du-copy",
        title: failed ? t("copyFailed", { path: entry.path }) : copied ? t("copied") : t("copyPath"),
        "aria-label": t("copyPath"),
        onClick: copy,
        style: iconButton(d),
        children: /* @__PURE__ */ jsx(Icon, { icon: copied ? "lucide:check" : "lucide:copy", width: d.touch ? 16 : 12 })
      }
    )
  ] });
}
function Status({ scan, now, t }) {
  const count = scan.tree.dirs.toLocaleString();
  if (scan.phase === "scanning") return /* @__PURE__ */ jsx("span", { children: t("scanning", { count, elapsed: elapsed(now - scan.startedAt) }) });
  if (scan.phase === "cancelled") return /* @__PURE__ */ jsx("span", { children: t("cancelled", { count }) });
  if (scan.phase === "error") {
    const noDu = scan.exitCode === 127 || /is not recognized/i.test(scan.lastError);
    return /* @__PURE__ */ jsx("span", { style: { color: "var(--t-status-error)" }, children: noDu ? t("noDu") : t("failed", { error: scan.lastError }) });
  }
  return /* @__PURE__ */ jsxs("span", { children: [
    t("scanned", { size: formatKb(sizeOf(scan.tree.root)), count, elapsed: elapsed((scan.finishedAt ?? now) - scan.startedAt) }),
    scan.unreadable > 0 && /* @__PURE__ */ jsxs("span", { title: scan.lastError, style: { color: "var(--t-status-warning)" }, children: [
      " \xB7 ",
      t("unreadable", { count: scan.unreadable })
    ] })
  ] });
}
function SessionDisk({ api, store, session, d }) {
  const t = useT(api);
  useSyncExternalStore(store.subscribe, store.getVersion);
  const scan = store.get(session.id);
  const [path, setPath] = useState(scan?.tree.root.path ?? "/");
  const now = useNow(scan?.phase === "scanning");
  useEffect(() => setPath(store.get(session.id)?.tree.root.path ?? "/"), [session.id, store]);
  const node = scan ? scan.tree.find(scan.current) ?? scan.tree.root : null;
  const files = scan && node ? store.filesFor(session.id, node.path) : void 0;
  const entries = useMemo(() => node ? entriesOf(node, files) : [], [node, files, store.version]);
  const total = node ? Math.max(sizeOf(node), entries.reduce((a, e) => a + e.kb, 0)) : 0;
  const open = (e) => e.dir && store.open(session.id, e.path);
  const scanning = scan?.phase === "scanning";
  const goHome = async () => {
    const home = await store.homeOf(session.id);
    if (home) setPath(home);
  };
  return /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: d.touch ? 12 : 8, padding: d.touch ? "12px 16px" : "8px 10px", fontSize: d.text, color: "var(--t-text-primary)" }, children: [
    !d.touch && /* @__PURE__ */ jsx("style", { children: `.du-row:hover{background:var(--t-bg-elevated)} .du-row .du-copy{opacity:0} .du-row:hover .du-copy{opacity:1}` }),
    /* @__PURE__ */ jsxs(
      "form",
      {
        onSubmit: (ev) => {
          ev.preventDefault();
          store.start(session.id, normalizePath(path));
        },
        style: { display: "flex", gap: 6 },
        children: [
          /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", flex: 1, minWidth: 0, height: d.touch ? 44 : "auto", border: "1px solid var(--t-border)", borderRadius: d.touch ? 10 : 6, background: "var(--t-bg-base)" }, children: [
            /* @__PURE__ */ jsx(
              "input",
              {
                value: path,
                onChange: (e) => setPath(e.target.value),
                placeholder: t("pathPlaceholder"),
                spellCheck: false,
                autoCapitalize: "off",
                autoCorrect: "off",
                style: { flex: 1, minWidth: 0, background: "transparent", border: 0, outline: "none", padding: d.touch ? "0 12px" : "4px 8px", fontSize: d.field, fontFamily: "var(--font-mono, monospace)", color: "var(--t-text-primary)" }
              }
            ),
            /* @__PURE__ */ jsx("button", { type: "button", title: t("home"), "aria-label": t("home"), onClick: () => void goHome(), style: { ...muted, padding: d.touch ? "0 12px" : "0 6px", alignSelf: "stretch" }, children: /* @__PURE__ */ jsx(Icon, { icon: "lucide:house", width: d.icon }) })
          ] }),
          scanning ? /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              onClick: () => store.cancel(session.id),
              style: { padding: d.touch ? "0 16px" : "4px 10px", borderRadius: d.touch ? 10 : 6, border: "1px solid var(--t-border)", color: "var(--t-text-primary)", fontSize: d.text },
              children: t("cancel")
            }
          ) : /* @__PURE__ */ jsx("button", { type: "submit", style: { padding: d.touch ? "0 18px" : "4px 10px", borderRadius: d.touch ? 10 : 6, background: "var(--t-accent)", color: "var(--t-bg-base)", fontSize: d.text, fontWeight: 600 }, children: scan ? t("rescan") : t("scan") })
        ]
      }
    ),
    !scan && /* @__PURE__ */ jsx("p", { style: { ...muted, margin: 0, lineHeight: 1.5 }, children: t("intro") }),
    scan && node && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("div", { style: { ...muted, fontSize: d.small }, children: /* @__PURE__ */ jsx(Status, { scan, now, t }) }),
      entries.length > 0 && /* @__PURE__ */ jsx(Treemap, { entries, total, onOpen: open, height: d.map }),
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            title: t("up"),
            "aria-label": t("up"),
            disabled: node === scan.tree.root,
            onClick: () => store.open(session.id, node.path.slice(0, node.path.lastIndexOf("/")) || "/"),
            style: { ...iconButton(d), opacity: node === scan.tree.root ? 0.4 : 1 },
            children: /* @__PURE__ */ jsx(Icon, { icon: "lucide:arrow-up", width: d.icon })
          }
        ),
        /* @__PURE__ */ jsx(Breadcrumb, { root: scan.tree.root.path, current: node.path, onOpen: (p) => store.open(session.id, p), d }),
        /* @__PURE__ */ jsx("span", { style: { marginLeft: "auto", fontWeight: 600, fontVariantNumeric: "tabular-nums" }, children: formatKb(total) })
      ] }),
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column" }, children: [
        entries.slice(0, MAX_ROWS).map((e) => /* @__PURE__ */ jsx(Row, { entry: e, total, onOpen: open, t, d }, e.path)),
        entries.length > MAX_ROWS && /* @__PURE__ */ jsx(Hint, { d, children: t("more", { count: entries.length - MAX_ROWS }) }),
        files === "loading" && /* @__PURE__ */ jsx(Hint, { d, children: t("loadingFiles") }),
        files === "error" && /* @__PURE__ */ jsx(Hint, { d, warn: true, children: t("filesFailed") }),
        entries.length === 0 && !scanning && files !== "loading" && /* @__PURE__ */ jsx(Hint, { d, children: t("empty") })
      ] })
    ] })
  ] });
}
function unavailable(t, session) {
  if (!session) return t("noSession");
  if (session.type === "serial") return t("unsupported");
  if (session.status !== "connected") return t("notConnected");
  return null;
}
function Disk({ api, store, session, d }) {
  const message = unavailable(useT(api), session);
  if (message || !session) {
    return /* @__PURE__ */ jsx("p", { style: { ...muted, margin: 0, padding: d.touch ? "16px" : "8px 10px", fontSize: d.text, lineHeight: 1.5 }, children: message });
  }
  return /* @__PURE__ */ jsx(SessionDisk, { api, store, session, d }, session.id);
}
function createDiskPanel(api, store) {
  return function DiskPanel() {
    return /* @__PURE__ */ jsx(Disk, { api, store, session: useActiveSession(api), d: DESKTOP });
  };
}
function createMobileDiskScreen(api, store) {
  return function MobileDiskScreen({ sessionId, onBack }) {
    const t = useT(api);
    const session = useSessionById(api, sessionId);
    return /* @__PURE__ */ jsxs("div", { style: { position: "absolute", inset: 0, zIndex: 30, display: "flex", flexDirection: "column", background: "var(--t-bg-base)" }, children: [
      /* @__PURE__ */ jsx(MobileScreenHeader, { title: t("title"), subtitle: session?.connectionName, onBack }),
      /* @__PURE__ */ jsx("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: "env(safe-area-inset-bottom, 0px)" }, children: /* @__PURE__ */ jsx(Disk, { api, store, session, d: TOUCH }) })
    ] });
  };
}

// src/store.ts
var NOTIFY_MS = 250;
var fileKey = (sessionId, dir) => `${sessionId}\0${dir}`;
var ScanStore = class {
  constructor(api) {
    this.api = api;
  }
  api;
  scans = /* @__PURE__ */ new Map();
  handles = /* @__PURE__ */ new Map();
  files = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  pending = null;
  version = 0;
  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  get(sessionId) {
    return this.scans.get(sessionId);
  }
  filesFor(sessionId, dir) {
    return this.files.get(fileKey(sessionId, dir));
  }
  notify(now = false) {
    if (now) {
      if (this.pending) clearTimeout(this.pending);
      this.pending = null;
    } else if (this.pending) {
      return;
    }
    const fire = () => {
      this.pending = null;
      this.version += 1;
      this.listeners.forEach((fn) => fn());
    };
    if (now) fire();
    else this.pending = setTimeout(fire, NOTIFY_MS);
  }
  start(sessionId, rootPath) {
    this.cancel(sessionId);
    const root = normalizePath(rootPath);
    const scan = {
      phase: "scanning",
      tree: new DuTree(root),
      current: root,
      unreadable: 0,
      lastError: "",
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null
    };
    this.scans.set(sessionId, scan);
    for (const key of [...this.files.keys()]) if (key.startsWith(fileKey(sessionId, ""))) this.files.delete(key);
    const stdout = lineSplitter((line) => {
      const entry = parseDuLine(line);
      if (entry) scan.tree.add(entry.kb, entry.path);
    });
    const stderr = lineSplitter((line) => {
      if (!line.trim()) return;
      scan.unreadable += 1;
      scan.lastError = line;
    });
    let handle;
    try {
      handle = this.api.host.stream(sessionId, scanCommand(root), {
        onStdout: (chunk) => {
          stdout.push(chunk);
          this.notify();
        },
        onStderr: (chunk) => stderr.push(chunk)
      });
    } catch (e) {
      this.finish(scan, "error", String(e));
      return;
    }
    this.handles.set(sessionId, handle);
    handle.done.then(
      (result) => {
        stdout.flush();
        stderr.flush();
        if (this.scans.get(sessionId) !== scan) return;
        scan.exitCode = result.code;
        if (result.cancelled) this.finish(scan, "cancelled");
        else if (scan.tree.dirs === 0) this.finish(scan, "error", scan.lastError || `exit ${result.code}`);
        else this.finish(scan, "done");
        this.loadFiles(sessionId, scan.current);
      },
      (e) => {
        if (this.scans.get(sessionId) === scan) this.finish(scan, "error", String(e));
      }
    );
    this.notify(true);
  }
  finish(scan, phase, error) {
    scan.phase = phase;
    scan.finishedAt = Date.now();
    if (error !== void 0) scan.lastError = error;
    this.notify(true);
  }
  cancel(sessionId) {
    this.handles.get(sessionId)?.cancel();
    this.handles.delete(sessionId);
  }
  open(sessionId, dir) {
    const scan = this.scans.get(sessionId);
    if (!scan) return;
    scan.current = dir;
    this.notify(true);
    if (scan.phase !== "scanning") this.loadFiles(sessionId, dir);
  }
  loadFiles(sessionId, dir) {
    const key = fileKey(sessionId, dir);
    if (this.files.has(key)) return;
    this.files.set(key, "loading");
    let pending;
    try {
      pending = this.api.host.exec(sessionId, filesCommand(dir), { timeoutMs: 2e4, maxBytes: 4 * 1024 * 1024 });
    } catch {
      this.files.set(key, "error");
      return;
    }
    pending.then(
      (r) => {
        this.files.set(key, parseFiles(r.stdout));
        this.notify(true);
      },
      () => {
        this.files.set(key, "error");
        this.notify(true);
      }
    );
  }
  async homeOf(sessionId) {
    try {
      const r = await this.api.host.exec(sessionId, HOME_COMMAND, { timeoutMs: 1e4 });
      return r.code === 0 && r.stdout.startsWith("/") ? r.stdout : null;
    } catch {
      return null;
    }
  }
  dispose() {
    for (const id of [...this.handles.keys()]) this.cancel(id);
    if (this.pending) clearTimeout(this.pending);
  }
};

// src/index.tsx
function register(api) {
  api.i18n.register(messages);
  const store = new ScanStore(api);
  const off = api.ui.registerRightPanelSection({
    id: "disk-usage",
    label: () => api.i18n.t("title"),
    icon: "lucide:hard-drive",
    component: createDiskPanel(api, store),
    order: 45
  });
  const offMobile = api.ui.registerMobileScreen({
    id: "disk-usage",
    kind: "disk-usage",
    render: createMobileDiskScreen(api, store)
  });
  return () => {
    off();
    offMobile();
    store.dispose();
  };
}
export {
  register as default
};
