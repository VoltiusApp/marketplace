#!/usr/bin/env node
// Bind a content hash to every plugins.json entry so the client's integrity check fires.
//
// For each entry we resolve the SAME index.js URL the client resolves
// (src/stores/marketplaceStore.ts) and compute its lowercase-hex SHA-256, matching the
// client's sha256Hex (src/plugins/integrity.ts).
//
//   node scripts/stamp-hashes.mjs            write hashes into plugins.json
//   node scripts/stamp-hashes.mjs --check    recompute and fail on any missing/mismatched hash
//
// In-repo plugins (repo -> raw.githubusercontent.com/<owner>/marketplace/<ref>/<dir>) are hashed
// from the working tree, so a PR is checked against its OWN proposed bytes, not stale main.
// External plugins are fetched over the network.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(repoRoot, "plugins.json");

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Base URL for an entry, mirroring marketplaceStore.installPlugin. */
function resolveBase(entry) {
  return entry.repo.startsWith("http")
    ? entry.repo
    : `https://github.com/${entry.repo}/releases/latest/download`;
}

/** If base points into THIS marketplace repo's raw tree, return the plugin dir; else null. */
function inRepoDir(base) {
  let url;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.host !== "raw.githubusercontent.com") return null;
  const parts = url.pathname.split("/").filter(Boolean); // <owner>/marketplace/<ref>/<dir...>
  if (parts.length < 4 || parts[1].toLowerCase() !== "marketplace") return null;
  return parts.slice(3).join("/");
}

/** Compute the lowercase-hex sha256 of an entry's index.js. */
async function computeHash(entry) {
  const base = resolveBase(entry);
  const dir = inRepoDir(base);
  if (dir !== null) {
    const file = join(repoRoot, dir, "index.js");
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      throw new Error(`${entry.id}: missing in-repo bundle ${dir}/index.js`);
    }
    return sha256Hex(bytes);
  }
  const url = `${base}/index.js`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`${entry.id}: failed to fetch ${url} (${e.message})`);
  }
  if (!res.ok) throw new Error(`${entry.id}: ${res.status} fetching ${url}`);
  return sha256Hex(Buffer.from(await res.arrayBuffer()));
}

/** Rebuild an entry with `hash` positioned right after `version`. */
function withHash(entry, hash) {
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === "hash") continue;
    out[k] = v;
    if (k === "version") out.hash = hash;
  }
  if (!("hash" in out)) out.hash = hash;
  return out;
}

async function main() {
  const check = process.argv.includes("--check");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));

  const stamped = [];
  const failures = [];
  for (const entry of catalog) {
    const actual = await computeHash(entry);
    if (check) {
      const declared = entry.hash?.trim().toLowerCase();
      if (!declared) failures.push(`${entry.id}: missing hash (expected ${actual})`);
      else if (declared !== actual)
        failures.push(`${entry.id}: hash mismatch (declared ${declared}, actual ${actual})`);
      else console.log(`${entry.id}: OK ${actual}`);
    } else {
      console.log(`${entry.id}: ${actual}`);
      stamped.push(withHash(entry, actual));
    }
  }

  if (check) {
    if (failures.length) {
      console.error("\nHash verification failed:");
      for (const f of failures) console.error(`  - ${f}`);
      console.error("\nRun `node scripts/stamp-hashes.mjs` and commit the result.");
      process.exit(1);
    }
    console.log("\nAll plugin hashes verified.");
    return;
  }

  await writeFile(catalogPath, `${JSON.stringify(stamped, null, 2)}\n`);
  console.log("\nplugins.json stamped.");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
