#!/usr/bin/env node
// Asserts the built bundle only imports modules the host provides.
//
// The list is fetched from Voltius itself, not hardcoded here: if the host ever
// drops a specifier, this fails in CI instead of in a plugin author's editor.
// Falls back to the pinned copy when offline.
import { readFileSync } from "node:fs";

const SRC =
  "https://raw.githubusercontent.com/VoltiusApp/voltius/main/src/plugins/hostSpecifiers.ts";
const FALLBACK = [
  "react", "react/jsx-runtime", "react-dom",
  "@iconify/react", "@voltius/ui", "@voltius/api",
];

async function hostSpecifiers() {
  try {
    const res = await fetch(SRC, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Strip comments first — that file explains itself with quoted examples
    // ("devicon", "simple-icons") that are not specifiers.
    const body = (await res.text())
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const arr = body.match(/HOST_SPECIFIERS\s*=\s*\[([\s\S]*?)\]/);
    if (!arr) throw new Error("could not find HOST_SPECIFIERS");
    const list = [...arr[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (list.length === 0) throw new Error("parsed an empty list");
    console.log(`host specifiers (live): ${list.join(", ")}`);
    return list;
  } catch (e) {
    console.log(`could not fetch the live list (${e.message}) — using the pinned copy`);
    return FALLBACK;
  }
}

const allowed = new Set(await hostSpecifiers());
const bundle = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const imported = new Set(
  [...bundle.matchAll(/from\s*"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s) => !s.startsWith("./") && !s.startsWith("../")),
);

const bad = [...imported].filter((s) => !allowed.has(s));
console.log(`bundle imports: ${[...imported].join(", ") || "(none)"}`);
if (bad.length) {
  console.error(
    `\nFAIL: these are bundled as bare imports but the host does not provide them:\n` +
      bad.map((s) => `  - ${s}`).join("\n") +
      `\n\nVoltius rejects any other bare specifier at load time and the plugin will not load.\n` +
      `Bundle them instead (drop the matching --external: flag).`,
  );
  process.exit(1);
}
console.log("\nOK: every bare import is provided by the host.");
