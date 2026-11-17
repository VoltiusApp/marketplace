import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DuTree,
  type DirNode,
  PROBE_COMMAND,
  dialectOf,
  filesCommand,
  formatKb,
  isDrivePath,
  lineSplitter,
  normalizePath,
  parseDuLine,
  parseFiles,
  psQuote,
  scanCommand,
  sizeOf,
  windowsFilesCommand,
  windowsScanCommand,
} from "./scan";

describe("DuTree", () => {
  test("builds the tree from du's children-first lines", () => {
    const tree = new DuTree("/var");
    tree.add(40, "/var/lib/docker");
    tree.add(50, "/var/lib");
    tree.add(8, "/var/log");
    tree.add(60, "/var");
    expect(tree.root.kb).toBe(60);
    expect(tree.find("/var/lib")?.kb).toBe(50);
    expect([...tree.find("/var/lib")!.children.keys()]).toEqual(["docker"]);
    expect(tree.find("/var/nope")).toBeNull();
  });

  test("an unfinished directory reports what has been seen inside it so far", () => {
    const tree = new DuTree("/");
    tree.add(30, "/usr/lib");
    tree.add(5, "/usr/bin");
    expect(tree.find("/usr")?.kb).toBeNull();
    expect(sizeOf(tree.root)).toBe(35);
  });

  test("partial sizes match a full re-sum at every step of a scan", () => {
    const lines: [number, string][] = [
      [4, "/a/x/1"], [6, "/a/x/2"], [12, "/a/x"], [3, "/a/y"], [20, "/a"], [7, "/b/z"], [9, "/b"], [40, "/"],
    ];
    const resum = (n: DirNode): number =>
      n.kb ?? [...n.children.values()].reduce((s, c) => s + resum(c), 0);
    const tree = new DuTree("/");
    for (const [kb, p] of lines) {
      tree.add(kb, p);
      const walk = (n: DirNode) => {
        expect(sizeOf(n)).toBe(resum(n));
        n.children.forEach(walk);
      };
      walk(tree.root);
    }
  });

  test("paths outside the root are ignored", () => {
    const tree = new DuTree("/home/me/");
    tree.add(1, "/etc");
    tree.add(2, "/home/me/a");
    expect(tree.root.path).toBe("/home/me");
    expect([...tree.root.children.keys()]).toEqual(["a"]);
  });
});

test("parseDuLine keeps tabs and spaces inside the path", () => {
  expect(parseDuLine("12\t/a b\tc")).toEqual({ kb: 12, path: "/a b\tc" });
  expect(parseDuLine("du: cannot read")).toBeNull();
  expect(parseDuLine("x\t/a")).toBeNull();
});

test("lineSplitter holds a partial line until it completes", () => {
  const seen: string[] = [];
  const split = lineSplitter((l) => seen.push(l));
  split.push("1\t/a\n2\t/");
  split.push("b\n3");
  split.flush();
  expect(seen).toEqual(["1\t/a", "2\t/b", "3"]);
});

test("formatKb", () => {
  expect(formatKb(512)).toBe("512 KB");
  expect(formatKb(1536)).toBe("1.5 MB");
  expect(formatKb(300 * 1024 * 1024)).toBe("300 GB");
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(dir, "sub dir"));
  writeFileSync(path.join(dir, "sub dir", "big"), Buffer.alloc(256 * 1024, 1));
  writeFileSync(path.join(dir, "top file"), Buffer.alloc(64 * 1024, 1));
  return dir;
}

describe.skipIf(process.platform === "win32")("commands against a real shell", () => {
  let dir = "";
  beforeAll(() => {
    dir = scratchDir("disk usage 'q' ");
    symlinkSync(path.join(dir, "sub dir"), path.join(dir, "link"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("scanCommand reports every directory under an awkward path", () => {
    const out = execFileSync("sh", ["-c", scanCommand(dir)], { encoding: "utf8" });
    const tree = new DuTree(dir);
    for (const line of out.trim().split("\n")) {
      const p = parseDuLine(line)!;
      tree.add(p.kb, p.path);
    }
    expect(tree.find(path.join(dir, "sub dir"))!.kb).toBeGreaterThanOrEqual(256);
    expect(tree.root.kb).toBeGreaterThanOrEqual(320);
  });

  test("filesCommand lists only the regular files directly inside", () => {
    const out = execFileSync("sh", ["-c", filesCommand(dir)], { encoding: "utf8" });
    expect(parseFiles(out).map((f) => f.name)).toEqual(["top file"]);
  });
});

describe("Windows sessions", () => {
  const decode = (command: string) => {
    const b64 = command.split(" ").pop()!;
    const bytes = Buffer.from(b64, "base64");
    return bytes.toString("utf16le");
  };

  test("the probe tells cmd and PowerShell from a POSIX shell", () => {
    expect(dialectOf("Windows_NT $PSHOME\r\n")).toBe("windows");
    expect(dialectOf("%OS%\r\nC:\\Windows\\System32\\WindowsPowerShell\\v1.0\r\n")).toBe("windows");
    expect(dialectOf("%OS%\n")).toBe("posix");
    expect(dialectOf("")).toBe("posix");
  });

  test("drive paths keep forward slashes and lose trailing ones", () => {
    expect(normalizePath(" C:\\Users\\me\\ ")).toBe("C:/Users/me");
    expect(normalizePath("C:\\")).toBe("C:");
    expect(normalizePath("d:/data/")).toBe("d:/data");
    expect(isDrivePath("C:")).toBe(true);
    expect(isDrivePath("/c/Users")).toBe(false);
  });

  test("a drive root holds its folders", () => {
    const tree = new DuTree("C:");
    tree.add(5, "C:/Users/me");
    tree.add(9, "C:/Users");
    tree.add(12, "C:");
    expect(tree.root.kb).toBe(12);
    expect(tree.find("C:/Users/me")?.kb).toBe(5);
  });

  test("the folder reaches PowerShell as one single-quoted literal", () => {
    expect(psQuote("a'b\u2019c")).toBe("'a''b\u2019\u2019c'");
    const script = decode(windowsScanCommand("C:/x 'y' $z"));
    expect(script).toContain("$p = 'C:/x ''y'' $z'");
    expect(windowsScanCommand("C:/a")).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(decode(windowsFilesCommand("C:/a"))).toContain("EnumerateFiles()");
  });

  describe.skipIf(process.platform !== "win32")("against a real PowerShell", () => {
    let root = "";
    beforeAll(() => {
      root = normalizePath(scratchDir("disk usage 'q' "));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const ps = (command: string) => execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });

    test("windowsScanCommand prints du's lines, children first", () => {
      const out = ps(windowsScanCommand(root));
      expect(out).not.toContain("\r");
      const tree = new DuTree(root);
      for (const line of out.trim().split("\n")) {
        const p = parseDuLine(line)!;
        tree.add(p.kb, p.path);
      }
      expect(tree.find(`${root}/sub dir`)!.kb).toBe(256);
      expect(tree.root.kb).toBe(320);
    });

    test("windowsFilesCommand lists only the files directly inside", () => {
      expect(parseFiles(ps(windowsFilesCommand(root))).map((f) => f.name)).toEqual(["top file"]);
    });

    test("the probe sees PowerShell", () => {
      expect(dialectOf(ps(PROBE_COMMAND))).toBe("windows");
    });
  });
});
