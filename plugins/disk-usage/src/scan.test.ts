import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuTree, type DirNode, filesCommand, formatKb, lineSplitter, parseDuLine, parseFiles, scanCommand, sizeOf } from "./scan";

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

describe("commands against a real shell", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "disk usage 'q' "));
  mkdirSync(path.join(dir, "sub dir"));
  writeFileSync(path.join(dir, "sub dir", "big"), Buffer.alloc(256 * 1024, 1));
  writeFileSync(path.join(dir, "top file"), Buffer.alloc(64 * 1024, 1));
  symlinkSync(path.join(dir, "sub dir"), path.join(dir, "link"));

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
