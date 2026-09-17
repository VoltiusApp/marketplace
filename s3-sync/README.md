# S3 Sync (Voltius plugin)

Marketplace plugin that syncs your **encrypted** Voltius vault through any **S3-compatible bucket** —
AWS S3, Cloudflare R2, Backblaze B2, Wasabi, Hetzner, Scaleway, MinIO or anything else that speaks the
S3 API. There is no server to deploy and no account to create with us: you point the plugin at a
bucket you already own, and it talks to it directly with SigV4-signed requests.

- Encryption stays on-device (`api.crypto.deriveKey` + `sync.exportState` / `importStates`)
- The bucket only ever holds opaque ciphertext plus a salt and a small per-device label
- Transport auth is an S3 access key ID + secret (never reuse the secret as the encryption passphrase)
- Scope the key to the one bucket — the plugin needs nothing else

## How it works

Everything lives under the folder you choose in the wizard (`voltius/` by default, and the folder can
be empty to use the bucket root):

```
<folder>/vault.json            {"schema":1,"salt":"<32 hex chars>"}
<folder>/devices/<id>.b64      this device's encrypted state, base64
<folder>/devices/<id>.json     {"label":"…","pushedAt":"…"}   (plaintext metadata only)
<folder>/.voltius-probe        written, read back and deleted by "Test and connect"
```

There is **no manifest object**. The device list comes from a `ListObjectsV2` call on
`<folder>/devices/`, and each device's version is the `ETag` S3 already returns for its `.b64` object,
so nothing has to be kept in sync with the directory listing and two devices pushing at once cannot
clobber a shared index.

Each device writes **only its own** `devices/<id>.*` pair and reads everyone else's. The passphrase
you choose derives the key locally; `vault.json` holds the salt so another device can derive the same
key from the same passphrase. The salt is created with `If-None-Match: *`, so on a provider that
honours that header the first device to create the vault wins and a race cannot replace an existing
salt. A provider that rejects the header (`400`/`501`) gets one plain `PUT` instead, and there two
devices creating a vault at the same moment can overwrite each other's salt — create the vault on one
device first. The passphrase itself is never sent anywhere.

Deletes (the probe object, and a removed device's two files) go through S3 multi-object delete, a
`POST ?delete` with a `Content-MD5` header, never a single-object `DELETE`. A service without
multi-object delete fails at the **Delete** step of *Test and connect*.

Removing a device from the list deletes its files, but a device that is still running and connected
pushes them again on its next sync. Disconnect or uninstall the plugin on that device first.

## Setup

1. **Create a bucket** in your provider's console. Any name and region works; the plugin does not
   create it for you.
2. **Create an access key limited to that bucket.** It needs nothing account-wide. On AWS, or any
   provider with IAM-style policies, that is:
   - `s3:ListBucket` on the bucket (`arn:aws:s3:::<bucket>`)
   - `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `arn:aws:s3:::<bucket>/<folder>/*`

   A key without `s3:ListBucket` shows up as *credentials rejected*, not as a missing permission: S3
   answers `AccessDenied` both to the device listing and to reading a file that does not exist yet.
   Step 2 of the wizard links to your provider's key documentation.
3. **Run the wizard** in **Settings → S3 Sync**:
   1. **Which storage provider?** Pick a preset, which fills in the endpoint pattern, the default
      region and the right addressing style. Pick *Other* for anything not listed.
   2. **Connect to your bucket.** Endpoint, region, bucket, folder and the key pair. *Test and
      connect* writes, reads back and deletes a probe object, so a wrong key or a missing bucket is
      reported here rather than on the first sync.
   3. **Passphrase.** A new bucket asks for a passphrase twice and creates the vault; a bucket that
      already holds one asks for its passphrase and links this device to it.

Settings are saved only once step 3 succeeds. The access key and secret go into this device's vault,
not into plugin storage.

## Providers

| Preset | Endpoint | Region | Addressing |
|---|---|---|---|
| AWS S3 | `https://s3.{region}.amazonaws.com` | e.g. `eu-west-3` | virtual-hosted |
| Cloudflare R2 | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | `auto` | path |
| Backblaze B2 | `https://s3.{region}.backblazeb2.com` | e.g. `eu-central-003` | path |
| Wasabi | `https://s3.{region}.wasabisys.com` | e.g. `eu-central-1` | path |
| MinIO | `http://localhost:9000` | usually `us-east-1` | path |
| Hetzner | `https://{region}.your-objectstorage.com` | `fsn1`, `nbg1` or `hel1` | virtual-hosted |
| Scaleway | `https://s3.{region}.scw.cloud` | `fr-par`, `nl-ams` or `pl-waw` | path |
| Other | whatever you enter | blank means `us-east-1` | path (a checkbox switches it) |

A preset only prefills the form — every field stays editable, so any S3 API works through *Other*.
`http://` endpoints are accepted only for `localhost`, private and link-local addresses (including
Tailscale's `100.64.0.0/10` and IPv6 `fc00::/7`/`fe80::/10`), single-label hostnames and names ending in
`.local`, `.lan`, `.home.arpa` or `.internal`; everything else must be `https://`.

A bucket name containing dots cannot be used with virtual-hosted addressing over `https://` (the
provider's wildcard certificate does not cover `a.b.s3.…`): the wizard refuses that combination, so
use path-style addressing or a bucket name without dots.

## Layout

- `src/` — the plugin
- `index.js` — the built bundle the catalogue serves. Rebuild it rather than editing it by hand,
  then run `node scripts/stamp-hashes.mjs` from the repository root.

## Build

```bash
npm ci                       # from the marketplace root: installs every workspace
npm run typecheck -w s3-sync
npm run build -w s3-sync
npm test -w s3-sync
npm run check -w s3-sync    # host specifier gate
```

Integration tests against a real MinIO (needs docker; starts and removes its own container):

```bash
npm run test:minio -w s3-sync
```

## Permissions

`vault:read/write`, `storage`, `http`, `crypto:derive`, `ui`, `sync:write`, `notifications`, `settings-page`.

## License

MIT
