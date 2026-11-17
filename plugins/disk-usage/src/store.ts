import type { HostStreamHandle, PluginAPI } from "@voltius/plugin-types";
import {
  DuTree,
  HOME_COMMAND,
  PROBE_COMMAND,
  WINDOWS_HOME_COMMAND,
  dialectOf,
  filesCommand,
  isDrivePath,
  lineSplitter,
  normalizePath,
  parseDuLine,
  parseFiles,
  scanCommand,
  windowsFilesCommand,
  windowsScanCommand,
  type Dialect,
  type FileEntry,
} from "./scan";

export type Phase = "scanning" | "done" | "cancelled" | "error";

export interface Scan {
  phase: Phase;
  tree: DuTree;
  current: string;
  unreadable: number;
  lastError: string;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export type Files = FileEntry[] | "loading" | "error";

const NOTIFY_MS = 250;

const fileKey = (sessionId: string, dir: string) => `${sessionId}\0${dir}`;

/** One scan per session, kept across tab switches so coming back shows the last result. */
export class ScanStore {
  private scans = new Map<string, Scan>();
  private handles = new Map<string, HostStreamHandle>();
  private files = new Map<string, Files>();
  private dialects = new Map<string, Promise<Dialect>>();
  private listeners = new Set<() => void>();
  private pending: ReturnType<typeof setTimeout> | null = null;
  version = 0;

  constructor(private api: PluginAPI) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  get(sessionId: string): Scan | undefined {
    return this.scans.get(sessionId);
  }

  /** Whether the session runs a POSIX shell or cmd/PowerShell, asked once per session. */
  private dialect(sessionId: string): Promise<Dialect> {
    let known = this.dialects.get(sessionId);
    if (!known) {
      known = Promise.resolve()
        .then(() => this.api.host.exec(sessionId, PROBE_COMMAND, { timeoutMs: 10_000 }))
        .then(
          (r) => dialectOf(r.stdout),
          () => {
            this.dialects.delete(sessionId);
            return "posix" as const;
          },
        );
      this.dialects.set(sessionId, known);
    }
    return known;
  }

  filesFor(sessionId: string, dir: string): Files | undefined {
    return this.files.get(fileKey(sessionId, dir));
  }

  private notify(now = false): void {
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

  start(sessionId: string, rootPath: string): void {
    this.cancel(sessionId);
    const root = normalizePath(rootPath);
    const scan: Scan = {
      phase: "scanning",
      tree: new DuTree(root),
      current: root,
      unreadable: 0,
      lastError: "",
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
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
    this.notify(true);
    void this.dialect(sessionId).then((dialect) => {
      if (this.scans.get(sessionId) !== scan || scan.phase !== "scanning") return;
      if (dialect === "windows" && !isDrivePath(root)) {
        this.finish(scan, "error", "windowsPath");
        return;
      }
      this.run(sessionId, scan, dialect, stdout, stderr);
    });
  }

  private run(
    sessionId: string,
    scan: Scan,
    dialect: Dialect,
    stdout: ReturnType<typeof lineSplitter>,
    stderr: ReturnType<typeof lineSplitter>,
  ): void {
    const root = scan.tree.root.path;
    let handle: HostStreamHandle;
    try {
      const command = dialect === "windows" ? windowsScanCommand(root) : scanCommand(root);
      handle = this.api.host.stream(sessionId, command, {
        onStdout: (chunk) => {
          stdout.push(chunk);
          this.notify();
        },
        onStderr: (chunk) => stderr.push(chunk),
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
      },
    );
  }

  private finish(scan: Scan, phase: Phase, error?: string): void {
    scan.phase = phase;
    scan.finishedAt = Date.now();
    if (error !== undefined) scan.lastError = error;
    this.notify(true);
  }

  cancel(sessionId: string): void {
    const handle = this.handles.get(sessionId);
    this.handles.delete(sessionId);
    if (handle) return handle.cancel();
    // Still asking the session which shell it runs: nothing has started yet.
    const scan = this.scans.get(sessionId);
    if (scan?.phase === "scanning") this.finish(scan, "cancelled");
  }

  open(sessionId: string, dir: string): void {
    const scan = this.scans.get(sessionId);
    if (!scan) return;
    scan.current = dir;
    this.notify(true);
    if (scan.phase !== "scanning") this.loadFiles(sessionId, dir);
  }

  private loadFiles(sessionId: string, dir: string): void {
    const key = fileKey(sessionId, dir);
    if (this.files.has(key)) return;
    this.files.set(key, "loading");
    this.dialect(sessionId)
      .then((dialect) => {
        const command = dialect === "windows" ? windowsFilesCommand(dir) : filesCommand(dir);
        return this.api.host.exec(sessionId, command, { timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 });
      })
      .then(
      (r) => {
        this.files.set(key, parseFiles(r.stdout));
        this.notify(true);
      },
      () => {
        this.files.set(key, "error");
        this.notify(true);
      },
    );
  }

  async homeOf(sessionId: string): Promise<string | null> {
    try {
      const windows = (await this.dialect(sessionId)) === "windows";
      const r = await this.api.host.exec(sessionId, windows ? WINDOWS_HOME_COMMAND : HOME_COMMAND, { timeoutMs: 10_000 });
      const ok = windows ? isDrivePath(r.stdout) : r.stdout.startsWith("/");
      return r.code === 0 && ok ? r.stdout : null;
    } catch {
      return null;
    }
  }

  dispose(): void {
    for (const id of [...this.handles.keys()]) this.cancel(id);
    if (this.pending) clearTimeout(this.pending);
  }
}
