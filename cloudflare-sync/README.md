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
npm ci                              # from the marketplace root: installs every workspace
npm run typecheck -w cloudflare-sync
npm run build -w cloudflare-sync
npm test -w cloudflare-sync
npm run check -w cloudflare-sync   # host specifier gate
```

Worker tests:

```bash
cd worker && npm ci && npm run typecheck && npm test
```

## Deploy the Worker

### In Voltius (recommended)

**Settings → Cloudflare Sync** walks through three steps:

1. **Where is your sync Worker?** Choose *Deploy one for me*, or *I already have one* for a second
   device or a Worker you deployed yourself.
2. **Deploy the Worker.** Enter your Account ID (in the Cloudflare dashboard press Ctrl+K and search
   *Account ID*) and an API token. The *Create a token* link opens Cloudflare's token page with
   Workers Scripts Edit, Workers R2 Storage Edit and Account Settings Read already selected. Deploy
   creates the R2 bucket if needed, uploads the bundled Worker and sets a freshly generated
   `SYNC_TOKEN`. With an existing Worker, enter its URL and sync token instead.
3. **Passphrase.** The plugin checks the Worker: a new vault asks for a passphrase twice and creates
   it, an existing vault asks for its passphrase and links it.

The Worker URL, sync token and passphrase are saved only once step 3 succeeds. The Cloudflare API
token is never saved. Once set up, the settings page shows the Worker URL and a link to copy the sync
token for your other devices.

### Manual / CLI

From `worker/`: `npm run setup:buckets`, `npm run deploy`, `npm run secret:token`. Then choose *I
already have one* in Voltius.

## Permissions

`vault:read/write`, `storage`, `http`, `crypto:derive`, `ui`, `sync:write`, `notifications`, `settings-page`.

## License

MIT
