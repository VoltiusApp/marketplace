#!/usr/bin/env node
// Bind a content hash and the declared permissions to every plugins.json entry, so the client's
// integrity check fires and the permissions a plugin requests are visible in the PR diff.
//
// For each entry we resolve the SAME index.js URL the client resolves
// (src/stores/marketplaceStore.ts) and compute its lowercase-hex SHA-256, matching the
// client's sha256Hex (src/plugins/integrity.ts). `permissions` is read from the manifest.json
// beside it. Unlike index.js the manifest is NOT hash-pinned by the client, so this binding is a
// review-time disclosure, not an install-time guarantee.
//
//   node scripts/stamp-hashes.mjs            write hashes and permissions into plugins.json
//   node scripts/stamp-hashes.mjs --check    recompute and fail on any missing/mismatched field
//
// In-repo plugins (repo -> raw.githubusercontent.com/<owner>/marketplace/<ref>/<dir>) are read
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

/** Read a file served alongside an entry: from the working tree in-repo, over the network else. */
async function readEntryFile(entry, filename) {
  const base = resolveBase(entry);
  const dir = inRepoDir(base);
  if (dir !== null) {
    const file = join(repoRoot, dir, filename);
    try {
      return await readFile(file);
    } catch {
      throw new Error(`${entry.id}: missing in-repo ${dir}/${filename}`);
    }
  }
  const url = `${base}/${filename}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`${entry.id}: failed to fetch ${url} (${e.message})`);
  }
  if (!res.ok) throw new Error(`${entry.id}: ${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Compute the lowercase-hex sha256 of an entry's index.js. */
async function computeHash(entry) {
  return sha256Hex(await readEntryFile(entry, "index.js"));
}

/** The permissions array and desktopOnly flag declared by an entry's manifest.json. */
async function computeManifestStamps(entry) {
  const text = (await readEntryFile(entry, "manifest.json")).toString("utf8");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    throw new Error(`${entry.id}: unparseable manifest.json (${e.message})`);
  }
  if (!Array.isArray(manifest.permissions)) {
    throw new Error(`${entry.id}: manifest.json declares no permissions array`);
  }
  return { permissions: manifest.permissions, desktopOnly: manifest.desktopOnly === true };
}

// Mirrors ThemePreviewPalette in the client (src/themes/marketplaceThemes.ts).
const PREVIEW_KEYS = {
  ui: ["bgTerminal", "accent", "tabActiveText", "statusConnected"],
  terminal: ["background", "foreground", "green", "blue", "yellow", "cyan"],
};
const HEX = /^#[0-9a-fA-F]{3,8}$/;

/** Problems with a preview palette's shape; empty when every field is a hex colour. */
function previewProblems(preview) {
  const problems = [];
  for (const [group, keys] of Object.entries(PREVIEW_KEYS)) {
    for (const key of keys) {
      const value = preview?.[group]?.[key];
      if (typeof value !== "string" || !HEX.test(value)) problems.push(`${group}.${key}=${JSON.stringify(value)}`);
    }
  }
  return problems;
}

/** Run an in-repo theme bundle against a stub API and pick the first registered theme's palette. */
async function generatePreview(entry) {
  const dir = inRepoDir(resolveBase(entry));
  if (dir === null || !entry.theme) return null;
  let theme = null;
  const noop = new Proxy(() => noop, { get: () => noop });
  const api = new Proxy({}, {
    get: (_, key) => {
      if (key === "isActive") return () => true;
      if (key === "themes") return { register: (t) => { theme ??= t; }, unregister: () => {} };
      return noop;
    },
  });
  const source = await readFile(join(repoRoot, dir, "index.js"));
  const mod = await import(`data:text/javascript;base64,${source.toString("base64")}`);
  (mod.default ?? mod.register)(api);
  if (!theme) throw new Error(`${entry.id}: theme bundle registered no theme`);
  const pick = (group) => Object.fromEntries(PREVIEW_KEYS[group].map((k) => [k, theme[group]?.[k]]));
  const preview = { ui: pick("ui"), terminal: pick("terminal") };
  const problems = previewProblems(preview);
  if (problems.length) throw new Error(`${entry.id}: theme colours are not hex: ${problems.join(", ")}`);
  return preview;
}

/** Order- and duplicate-insensitive identity for a permission list. */
const permsKey = (perms) => [...new Set(perms)].sort().join(",");

/** Rebuild an entry with its stamps positioned right after `version`; a null stamp is dropped. */
function withStamps(entry, stamps) {
  const defined = Object.entries(stamps).filter(([, v]) => v !== null);
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k in stamps) continue;
    out[k] = v;
    if (k === "version") Object.assign(out, Object.fromEntries(defined));
  }
  for (const [k, v] of defined) if (!(k in out)) out[k] = v;
  return out;
}

async function main() {
  const check = process.argv.includes("--check");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));

  const stamped = [];
  const failures = [];
  for (const entry of catalog) {
    const actual = await computeHash(entry);
    const { permissions: actualPerms, desktopOnly } = await computeManifestStamps(entry);
    const generatedPreview = await generatePreview(entry);
    const preview = generatedPreview ?? entry.preview ?? null;
    if (check) {
      const before = failures.length;

      const declared = entry.hash?.trim().toLowerCase();
      if (!declared) failures.push(`${entry.id}: missing hash (expected ${actual})`);
      else if (declared !== actual)
        failures.push(`${entry.id}: hash mismatch (declared ${declared}, actual ${actual})`);

      const declaredPerms = entry.permissions;
      if (!Array.isArray(declaredPerms))
        failures.push(`${entry.id}: missing permissions (expected ${JSON.stringify(actualPerms)})`);
      else if (permsKey(declaredPerms) !== permsKey(actualPerms))
        failures.push(
          `${entry.id}: permissions mismatch (declared ${JSON.stringify(declaredPerms)}, ` +
            `manifest ${JSON.stringify(actualPerms)})`,
        );

      if ((entry.desktopOnly === true) !== desktopOnly)
        failures.push(`${entry.id}: desktopOnly mismatch (declared ${entry.desktopOnly === true}, manifest ${desktopOnly})`);

      if (entry.preview !== undefined) {
        const problems = previewProblems(entry.preview);
        if (problems.length) failures.push(`${entry.id}: preview colours must be hex: ${problems.join(", ")}`);
      }
      if (generatedPreview && JSON.stringify(entry.preview) !== JSON.stringify(generatedPreview))
        failures.push(`${entry.id}: preview out of date (expected ${JSON.stringify(generatedPreview)})`);

      if (failures.length === before) console.log(`${entry.id}: OK ${actual}`);
    } else {
      console.log(`${entry.id}: ${actual} ${JSON.stringify(actualPerms)}`);
      stamped.push(withStamps(entry, { hash: actual, permissions: actualPerms, desktopOnly: desktopOnly || null, preview }));
    }
  }

  if (check) {
    if (failures.length) {
      console.error("\nCatalogue verification failed:");
      for (const f of failures) console.error(`  - ${f}`);
      console.error("\nRun `node scripts/stamp-hashes.mjs` and commit the result.");
      process.exit(1);
    }
    console.log("\nAll plugin hashes and permissions verified.");
    return;
  }

  await writeFile(catalogPath, `${JSON.stringify(stamped, null, 2)}\n`);
  console.log("\nplugins.json stamped.");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
