# Voltius Plugin Marketplace

The official plugin registry for [Voltius](https://github.com/voltiusApp/voltius) — Open-Source SSH & SFTP Client built with Tauri, React, and Rust.

## For users

Browse and install plugins directly from the **Settings → Plugins → Browse** tab in Voltius. No account required.

> **Trust model.** A plugin runs with the app's full privileges — Voltius does not sandbox it, the same as a browser or editor extension. A listing here means the submission was reviewed, but installing a plugin is a trust decision. Install ones whose source you trust; the permissions a plugin declares are shown before you install.

## For plugin authors

The full developer guide — quickstart, `PluginAPI` reference, permissions, and publishing — lives in the Voltius docs:

**[docs.voltius.app/plugins/developing](https://docs.voltius.app/plugins/developing)**

To submit a plugin, open a PR adding your entry to [`plugins.json`](plugins.json). See [CONTRIBUTING.md](CONTRIBUTING.md) for the entry schema and the [publishing guide](https://docs.voltius.app/plugins/developing#publishing) for review criteria. Before submitting, run `node scripts/stamp-hashes.mjs` to bind a content hash to your entry so installs are integrity-verified (CI enforces it).

Because plugins are trusted code and run without a runtime sandbox, review is the security boundary — declared permissions must match what the code actually uses, and there must be no deceptive or malicious behavior.

## Contributing

The simplest contribution is adding your plugin to `plugins.json` via a PR. See [CONTRIBUTING.md](CONTRIBUTING.md).
