# Cloudflare Sync (Voltius plugin)

Marketplace plugin that syncs your **encrypted** Voltius vault through a **bring-your-own**
Cloudflare Worker + R2 store. Originally written by [mrchatam](https://github.com/mrchatam)
([plugin](https://github.com/mrchatam/voltius-plugin-cloudflare-sync),
[Worker](https://github.com/mrchatam/voltius-cloudflare-sync-worker)); this directory carries the
reviewed copy the catalogue serves.

- Encryption stays on-device (`api.crypto.deriveKey` + `sync.exportState` / `importStates`)
- The Worker only stores opaque ciphertext + device metadata
- Transport auth is a Bearer `SYNC_TOKEN` (never reuse it as the encryption passphrase)
- **In-app Deploy Worker** uses the Cloudflare HTTP API (Account ID + API token) so you never leave Voltius Settings

Tracking: [VoltiusApp/voltius#267](https://github.com/VoltiusApp/voltius/issues/267).

## Why Cloudflare Sync instead of Gist?

Gist Sync is still the simplest path if you already have GitHub. Choose **Cloudflare Sync** when you want:

| | Cloudflare Sync | Gist Sync |
|---|---|---|
| Storage you control | Your R2 bucket | GitHub Gist |
| Account required | Cloudflare | GitHub + PAT |
| Deploy | In-app (API token) or Deploy-to-Cloudflare | Paste gist token |
| Backend shape | Dedicated Worker API + ETag concurrency | Gist file API |
| Encryption | Client-side E2EE (passphrase) | Client-side E2EE (passphrase) |

## Layout

- `src/` — the plugin
- `worker/` — the Worker source. `npm run build` bundles it and inlines it into `index.js`, so the
  catalogue hash covers the exact Worker that **Deploy Worker** uploads.
- `index.js` — the built bundle the catalogue serves. Rebuild it rather than editing it by hand,
  then run `node scripts/stamp-hashes.mjs` from the repository root.

## Build

```bash
npm ci
npm run typecheck
npm run build       # → index.js (with worker/ inlined)
npm run check       # host specifier gate
```

Worker tests:

```bash
cd worker && npm ci && npm run typecheck && npm test
```

## Deploy the Worker

### In Voltius (recommended)

**Settings → Cloudflare Sync → Deploy Worker**:

1. Cloudflare Account ID + API token (Workers Scripts Edit, Workers R2 Storage Edit, Account Settings Read)
2. **Generate sync token**
3. **Deploy Worker** — creates the R2 bucket if needed, uploads the bundled Worker, sets `SYNC_TOKEN`, fills Worker URL
4. Enter a **separate** encryption passphrase → **Create vault** / **Link existing**

The Worker URL, sync token and passphrase are saved only when Create vault or Link existing
succeeds. The Cloudflare API token is kept in React state only (never persisted). Account ID /
Worker name / bucket name are stored in plugin storage.

### Manual / CLI

From `worker/`: `npm run setup:buckets`, `npm run deploy`, `npm run secret:token`.
The **Copy Deploy-to-Cloudflare URL** button deploys the upstream Worker repository instead of this copy.

## Permissions

`vault:read/write`, `storage`, `http`, `crypto:derive`, `ui`, `sync:write`, `notifications`, `settings-page`.

## License

MIT
