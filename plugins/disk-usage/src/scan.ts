export interface DirNode {
  name: string;
  path: string;
  /** Own `du` total in KiB; null until du reports this directory (it reports children first). */
  kb: number | null;
  /** Sum of the children du has already reported, so a partial size never re-walks finished subtrees. */
  doneKb: number;
  children: Map<string, DirNode>;
}

export interface FileEntry {
  name: string;
  path: string;
  kb: number;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Wrapped in `sh -c` so a fish or zsh login shell on the host never parses the script.
function sh(script: string, ...args: string[]): string {
  return `sh -c ${shellQuote(script)} sh ${args.map(shellQuote).join(" ")}`;
}

export function scanCommand(root: string): string {
  return sh(
    'if command -v ionice >/dev/null 2>&1; then exec nice -n 19 ionice -c3 du -xk -- "$1"; fi; exec nice -n 19 du -xk -- "$1"',
    root,
  );
}

export function filesCommand(dir: string): string {
  return sh('find "$1" -maxdepth 1 -type f -exec du -k {} + 2>/dev/null', dir);
}

export const HOME_COMMAND = sh('printf %s "$HOME"');

export function normalizePath(p: string): string {
  const trimmed = p.trim();
  if (trimmed === "" || trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

/** `<kib>\t<path>`, the line format GNU, BSD and busybox du all print. */
export function parseDuLine(line: string): { kb: number; path: string } | null {
  const tab = line.indexOf("\t");
  if (tab <= 0) return null;
  const kb = Number(line.slice(0, tab));
  const path = line.slice(tab + 1);
  if (!Number.isFinite(kb) || path === "") return null;
  return { kb, path };
}

function basename(path: string): string {
  return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
}

export class DuTree {
  readonly root: DirNode;
  dirs = 0;

  constructor(rootPath: string) {
    const path = normalizePath(rootPath);
    this.root = { name: basename(path), path, kb: null, doneKb: 0, children: new Map() };
  }

  /** Splits a du line's path below the root; anything outside it is ignored. */
  add(kb: number, rawPath: string): void {
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
        child = { name, path: childPath, kb: null, doneKb: 0, children: new Map() };
        node.children.set(name, child);
      }
      parent = node;
      node = child;
    }
    if (node.kb === null) parent.doneKb += kb;
    node.kb = kb;
  }

  find(path: string): DirNode | null {
    const target = normalizePath(path);
    if (target === this.root.path) return this.root;
    const prefix = this.root.path === "/" ? "/" : `${this.root.path}/`;
    if (!target.startsWith(prefix)) return null;
    let node: DirNode | undefined = this.root;
    for (const name of target.slice(prefix.length).split("/")) {
      node = node.children.get(name);
      if (!node) return null;
    }
    return node;
  }
}

/** A directory's size; while du has not reached it yet, the sum of what it has seen inside. */
export function sizeOf(node: DirNode): number {
  if (node.kb !== null) return node.kb;
  let sum = node.doneKb;
  for (const child of node.children.values()) if (child.kb === null) sum += sizeOf(child);
  return sum;
}

export function parseFiles(output: string): FileEntry[] {
  const files: FileEntry[] = [];
  for (const line of output.split("\n")) {
    const parsed = parseDuLine(line);
    if (parsed) files.push({ name: basename(parsed.path), path: parsed.path, kb: parsed.kb });
  }
  return files;
}

/** Turns streamed chunks into whole lines, holding back a trailing partial one. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
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
    },
  };
}

export function formatKb(kb: number): string {
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
