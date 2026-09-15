# Voltius Cloudflare Sync Worker

Bring-your-own **Cloudflare Worker + R2** backend for syncing a Voltius vault.

The Worker stores **opaque ciphertext** and minimal sync metadata (device ids, labels, timestamps, KDF salt).  
Vault encryption stays in the Voltius client. This Worker never sees your passphrase or plaintext hosts/keys.

Tracking: [VoltiusApp/voltius#267](https://github.com/VoltiusApp/voltius/issues/267) (marketplace-only; core PR #268 closed)

---

## Deploy (pick one)

### Option 1 — Deploy from Voltius plugin Settings (recommended)

Install the Cloudflare Sync marketplace plugin, open **Settings → Cloudflare Sync**, and use the **Deploy Worker** section:

1. Paste your Cloudflare **Account ID** and an **API token** (see permissions below).
2. Optionally change Worker name / R2 bucket (defaults: `voltius-cloudflare-sync` / `voltius-vault-sync`).
3. Click **Generate sync token**, then **Deploy Worker**.
4. The plugin creates the R2 bucket if needed, uploads this Worker bundle, sets `SYNC_TOKEN`, fills the Worker URL, and toasts success.
5. Add a **separate** encryption passphrase → **Create vault** or **Link existing**.

The plugin build bundles this directory into the plugin itself, so the uploaded Worker is covered by the catalogue hash (no Wrangler required on your machine).

### Option 2 — Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mrchatam/voltius-cloudflare-sync-worker)

**After the button finishes:**

1. Open the new Worker in the Cloudflare dashboard → **Settings** → **Variables and Secrets**.
2. Add secret `SYNC_TOKEN` = a long random string (password manager is fine).
3. Copy the Worker URL (e.g. `https://voltius-cloudflare-sync.<account>.workers.dev`).
4. In Voltius → **Cloudflare Sync** plugin → paste URL + token + a **separate** encryption passphrase → **Create vault** or **Link existing**.

### Option 3 — Wrangler CLI

Requires Node 20+ and a Cloudflare account (`npx wrangler login` once).

```bash
git clone https://github.com/mrchatam/voltius-cloudflare-sync-worker.git
cd voltius-cloudflare-sync-worker

npm install
npx wrangler login
npm run setup:buckets              # creates R2 buckets (ignore "already exists")
npm run deploy
npm run secret:token               # prompts for SYNC_TOKEN
```

Or the all-in-one:

```bash
npm run deploy:easy
```

Then paste the printed Worker URL into the Voltius plugin settings.

### Option 4 — Local dev

```bash
cp .dev.vars.example .dev.vars   # set SYNC_TOKEN=
npm install
npm run dev                      # http://127.0.0.1:8787
```

---

## API token permissions (in-app deploy)

Create a [Cloudflare API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) with at least:

| Permission | Level | Why |
|------------|-------|-----|
| **Account → Workers Scripts** | Edit | Upload / update the Worker script |
| **Account → Workers R2 Storage** | Edit | Create the R2 bucket + bind `VAULT_BUCKET` |
| **Account → Account Settings** | Read | Resolve your `*.workers.dev` subdomain |

Account resources: include the account you will deploy into.  
Do **not** use a Global API Key. The Voltius plugin keeps the token in memory only (not persisted).

---

## Connect Voltius

| Field | Value |
|-------|--------|
| Worker URL | Your `*.workers.dev` (or custom domain) — no trailing slash needed |
| Sync token | Same value as Worker secret `SYNC_TOKEN` |
| Encryption passphrase | **Different** from the token — used only on-device for vault crypto |

Use **Create vault** on the first device, **Link existing** on the next ones.

---

## HTTP API (MVP)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/health` | no | Liveness |
| OPTIONS | `*` | no | CORS preflight |
| GET/PUT | `/v1/manifest` | Bearer | `{ schema:1, salt, devices[] }` — GET sends `ETag`; PUT honors `If-Match` (412 on mismatch) |
| GET/PUT/DELETE | `/v1/devices/:id` | Bearer | PUT `{ content, label, pushedAt }` — `If-Match` is the **manifest** ETag (RMW); 412 on mismatch. GET still returns device `etag`. |

R2 keys: `manifest.json`, `devices/{id}.b64`

Quick check:

```bash
curl -sS "$WORKER_URL/health"
curl -sS -H "Authorization: Bearer $SYNC_TOKEN" "$WORKER_URL/v1/manifest"
```

---

## Develop / test this package

```bash
npm install
npm test
npm run typecheck
```

## License

MIT — clean-room example; not a copy of the Voltius AGPL sync server.

## Security

See [SECURITY.md](./SECURITY.md) for the threat model and operational checklist. There is **no** Worker HTML UI for key management — that stays in the Voltius client.
