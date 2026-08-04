#!/usr/bin/env node
// Builds snippets.json from snippets/entries/*.json, validating as it goes.
// One file per entry keeps concurrent submissions from conflicting; the client
// fetches the single built file.
//
//   node scripts/build-snippets.mjs           # write snippets.json
//   node scripts/build-snippets.mjs --check   # verify it matches the entries (CI)

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ENTRY_DIR = "snippets/entries";
const OUT = "snippets.json";
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const errors = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);

function validateSnippet(file, s, i, eids) {
  const at = `snippets[${i}]`;
  if (typeof s.name !== "string" || !s.name) fail(file, `${at}.name must be a non-empty string`);
  if (typeof s._eid !== "string" || !s._eid) fail(file, `${at}._eid must be a non-empty string`);
  else if (eids.has(s._eid)) fail(file, `${at}._eid "${s._eid}" is duplicated`);
  else eids.add(s._eid);

  for (const key of ["tags", "only_for_connection_tags", "only_for_distros"]) {
    if (!Array.isArray(s[key])) fail(file, `${at}.${key} must be an array`);
  }
  if (typeof s.favorite !== "boolean") fail(file, `${at}.favorite must be a boolean`);
  if (!Array.isArray(s.steps) || s.steps.length === 0) {
    fail(file, `${at}.steps must be a non-empty array`);
    return;
  }
  for (const [j, step] of s.steps.entries()) {
    const sat = `${at}.steps[${j}]`;
    if (step.kind === "script") {
      if (typeof step.content !== "string") fail(file, `${sat}.content must be a string`);
    } else if (step.kind === "transfer") {
      for (const key of ["from", "to", "from_path", "to_path", "mode", "on_conflict"]) {
        if (typeof step[key] !== "string") fail(file, `${sat}.${key} must be a string`);
      }
    } else if (step.kind === "snippet") {
      // Nested calls travel as _eid; a local snippet_id means nothing here.
      if (typeof step._eid !== "string") fail(file, `${sat} must reference a sibling via _eid`);
      if ("snippet_id" in step) fail(file, `${sat} must not carry a machine-local snippet_id`);
    } else {
      fail(file, `${sat}.kind must be script, transfer or snippet`);
    }
  }
}

function loadEntry(file) {
  const path = join(ENTRY_DIR, file);
  let entry;
  try {
    entry = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(file, `invalid JSON — ${e.message}`);
    return null;
  }

  const expectedId = file.replace(/\.json$/, "");
  if (entry.id !== expectedId) fail(file, `id "${entry.id}" must match the filename ("${expectedId}")`);
  if (!ID_RE.test(entry.id ?? "")) fail(file, `id must be lowercase kebab-case`);
  if (entry.kind !== "pack" && entry.kind !== "snippet") fail(file, `kind must be "pack" or "snippet"`);
  if (typeof entry.name !== "string" || !entry.name) fail(file, `name must be a non-empty string`);
  if (!Array.isArray(entry.tags)) fail(file, `tags must be an array`);
  if (!Array.isArray(entry.snippets) || entry.snippets.length === 0) {
    fail(file, `snippets must be a non-empty array`);
    return entry;
  }
  if (entry.kind === "snippet" && entry.snippets.length !== 1) {
    fail(file, `a "snippet" entry carries exactly one snippet — use kind "pack" for ${entry.snippets.length}`);
  }

  const eids = new Set();
  entry.snippets.forEach((s, i) => validateSnippet(file, s, i, eids));

  // Every nested call must resolve inside its own entry.
  for (const [i, s] of entry.snippets.entries()) {
    for (const step of s.steps ?? []) {
      if (step.kind === "snippet" && step._eid && !eids.has(step._eid)) {
        fail(file, `snippets[${i}] calls _eid "${step._eid}", which is not in this entry`);
      }
    }
  }
  return entry;
}

if (!existsSync(ENTRY_DIR)) {
  console.error(`${ENTRY_DIR} does not exist`);
  process.exit(1);
}

const files = readdirSync(ENTRY_DIR).filter(f => f.endsWith(".json")).sort();
const entries = files.map(loadEntry).filter(Boolean);

const seen = new Set();
for (const e of entries) {
  if (seen.has(e.id)) errors.push(`duplicate entry id "${e.id}"`);
  seen.add(e.id);
}

if (errors.length > 0) {
  console.error("Snippet catalogue validation failed:\n");
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

const catalog = JSON.stringify({ version: 1, entries }, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== catalog) {
    console.error(`${OUT} is out of date — run: node scripts/build-snippets.mjs`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date (${entries.length} entries).`);
} else {
  writeFileSync(OUT, catalog);
  console.log(`Wrote ${OUT} (${entries.length} entries).`);
}
