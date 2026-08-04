# Contributing to the Voltius Marketplace

This repo hosts two catalogues: plugins (`plugins.json`, below) and snippets
(`snippets.json`, see [Contributing snippets](#contributing-snippets)). They have
different trust models — read whichever section matches what you're submitting.

To list a plugin, open a PR that adds an entry to [`plugins.json`](plugins.json).

Because plugins run as trusted code with no runtime sandbox, **review is the security boundary**.
Declared permissions must match what the code actually uses, and there must be no deceptive or
malicious behavior. See the [developer guide](https://docs.voltius.app/plugins/developing) for the
full `PluginAPI` reference and publishing criteria.

## Entry schema

Each element of `plugins.json` is an object:

| Field         | Required | Description                                                                              |
| ------------- | -------- | ---------------------------------------------------------------------------------------- |
| `id`          | yes      | Unique slug; matches the plugin's `manifest.json` `id` and (for in-repo plugins) its dir |
| `name`        | yes      | Display name                                                                             |
| `author`      | yes      | Author handle                                                                            |
| `description` | yes      | One-line summary                                                                         |
| `repo`        | yes      | Where the bundle is served (see below)                                                   |
| `version`     | yes      | Semver; matches `manifest.json`                                                          |
| `hash`        | yes\*    | Lowercase-hex SHA-256 of the served `index.js` — see [Integrity](#integrity)             |
| `permissions` | yes      | The permissions the served `manifest.json` declares — see [Permissions](#permissions)    |
| `tags`        | no       | Array of strings for search/filtering                                                    |
| `theme`       | no       | `true` for theme-only plugins                                                            |

`repo` is resolved the same way the client resolves it: if it starts with `http` it is used as-is;
otherwise it is treated as `owner/name` and the bundle is fetched from
`https://github.com/<owner>/<name>/releases/latest/download`. The client fetches `manifest.json`
and `index.js` from that base.

\* `hash` is optional in the schema — an entry without it still installs, but the client marks it
**Unverified**. New submissions should include it so installs are integrity-verified.

## Integrity

The client computes the SHA-256 of the fetched `index.js` at install time and **refuses to execute**
a bundle whose bytes do not match the entry's `hash`. This binds the reviewed bundle to the one your
users actually run, and catches a later `releases/latest` swap or a compromised author account.

**Before submitting, stamp your entry:**

```sh
node scripts/stamp-hashes.mjs          # writes the correct hash and permissions into every entry
node scripts/stamp-hashes.mjs --check  # what CI runs; must pass
```

The script resolves each entry's `index.js` and `manifest.json` exactly as the client does — reading
the in-repo files for plugins served from this repo's `raw.githubusercontent.com/.../marketplace/...`
tree, or fetching the release assets for external plugins. CI runs `--check` on every PR and on
`main`; a missing or wrong hash, or a `permissions` array that disagrees with the manifest, fails the
check. Re-run `stamp-hashes.mjs` and commit whenever you ship a new bundle.

## Naming

**Do not use a third-party trademark in a plugin's `id`, `name`, `description`, directory, package
name, or theme id.** That is the only naming constraint. There is no house style — within that rule
the name is yours to choose.

Naming a plugin after the thing it **integrates with** is fine: "Docker", "Proxmox LXC" and
"GitHub Gist Sync" describe what the plugin does and imply no affiliation. The rule bites when a
plugin is named after a product it **resembles** — a theme named for another terminal, for instance —
because that implies an endorsement that does not exist.

If a rename is needed, it has to happen **before** the entry is merged:

- A theme's `id` is the key a user's saved theme selection persists under. Renaming it after merge
  silently reverts everyone who had picked it.
- A rename changes the bundle bytes, so `node scripts/stamp-hashes.mjs` must be re-run and the new
  hash committed.

## Permissions

A plugin's `manifest.json` declares the permissions it needs, and the client enforces them: calling a
`PluginAPI` method whose permission was not declared throws. Plugins run in a Node-less webview, so
this is a real capability boundary — `PluginAPI` is the only way out.

### The tiers

**Public** — everything not listed below. Disclosed to the user at install, with no separate consent
step.

**Gated, read-only** — `metrics:read`, `processes:read`, `docker:read`, `proxmox:read`. Always
requires explicit install consent, but is presented as read-only access rather than a danger warning:
these expose infrastructure inventory and telemetry and cannot change anything.

**Gated, danger** — `terminal:read`, `terminal:stream`, `terminal:write`, `keychain:read`,
`keychain:write`, `processes:manage`, `docker:manage`, `proxmox:manage`. Destructive, or exposes the
user's own secrets and content. Consent is danger-styled.

The split is about **what the grant exposes, not whether the verb is a read**. `terminal:read` and
`keychain:read` are reads and stay in the danger tier, because they read the user's secrets and
content rather than a container list.

### What we require

**Any plugin may request any permission, including a third-party one.** The gate is manifest
declaration plus the user's install-time consent — not who wrote the plugin. There is no
first-party-only tier, and no permission is refused a listing outright.

What we do require:

1. **Every declared permission must be justified by the plugin's described functionality.** A theme
   has no business declaring `terminal:read`. A submission whose permissions exceed what its
   `description` accounts for is sent back — either narrow the permissions or describe the feature
   that needs them.
2. **Declaring a gated permission requires published, readable source.** A public-tier plugin may
   ship an opaque bundle; once a gated permission is in play a reviewer has to be able to check the
   declaration against what the code actually calls. Publish the source at the entry's `repo` or link
   it from there.
3. **The entry's `permissions` must match the served `manifest.json`.** `stamp-hashes.mjs` writes
   this for you and CI enforces it.

Note what this is and is not. Listing rules govern **this catalogue**; the client honours whatever
permissions a user consents to, wherever the plugin came from, so declining to list a plugin does not
prevent anyone installing it by URL. Likewise, the entry's `permissions` is a disclosure that makes
the request visible in the PR diff and pins it at review time — unlike `index.js`, `manifest.json` is
not hash-pinned by the client, so it is not an install-time guarantee.

## Reviewer checklist

What a reviewer checks on every submission. Run through it yourself before opening the PR.

- [ ] `id` matches the plugin's `manifest.json` `id`, and its directory for in-repo plugins.
- [ ] Name, description, directory and theme id are clear of third-party trademarks
      (see [Naming](#naming)).
- [ ] `version` matches `manifest.json`.
- [ ] The `verify` check is green — hash and `permissions` both agree with what is served.
- [ ] Every declared permission is accounted for by the `description`.
- [ ] If any gated permission is declared: source is published and readable.
- [ ] The source's `PluginAPI` use does not exceed what the manifest declares, and nothing declared
      is left unused.
- [ ] Network egress (`api.http`, `fetch`) combined with a gated read has a stated reason.
- [ ] Nothing deceptive: the plugin does what the entry says it does, and nothing else.

## Contributing snippets

To list a snippet or a pack, open a PR that adds an entry to [`snippets.json`](snippets.json).

A snippet is plain text. The client shows the whole script before install and again
before it runs, and nothing executes until you pick a target and confirm. There is no
hash-binding as there is for plugins, and none is needed — **review is still the
boundary, but the user is the last check.**

### Entry schema

| Field         | Required | Description                                                                    |
| ------------- | -------- | ------------------------------------------------------------------------------ |
| `id`          | yes      | Unique slug across the whole catalogue                                          |
| `kind`        | yes      | `"snippet"` (exactly one snippet) or `"pack"` (installs as a folder)            |
| `name`        | yes      | Display name; for a pack this becomes the folder name                           |
| `description` | yes      | One or two lines; shown on the card and the detail page                         |
| `author`      | yes      | Author handle                                                                   |
| `tags`        | no       | Array of strings for search and filtering                                       |
| `updated_at`  | no       | `YYYY-MM-DD`                                                                    |
| `snippets`    | yes      | Non-empty array of snippet objects                                              |

Each snippet object:

| Field                       | Required | Description                                                        |
| --------------------------- | -------- | -------------------------------------------------------------------- |
| `_eid`                      | yes      | Unique **within the entry** (`s0`, `s1`, …); the installer renames it |
| `name`                      | yes      | Snippet name                                                        |
| `description`               | no       | Shown in the preview                                                |
| `tags`                      | yes      | Array (may be empty)                                                |
| `favorite`                  | yes      | Boolean                                                             |
| `only_for_connection_tags`  | yes      | Array (may be empty)                                                |
| `only_for_distros`          | yes      | Array (may be empty)                                                |
| `steps`                     | yes      | Non-empty array of steps                                            |

A step is `{"kind": "script", "content": "…"}`, a transfer, or `{"kind": "snippet",
"_eid": "…"}` calling another snippet **in the same entry**. Picking a snippet that
calls another pulls the callee in automatically.

A malformed entry is skipped silently by the client rather than breaking the tab —
so a mistake here costs you your listing without any visible error. Check your
entry parses before opening the PR.

The easiest way to author an entry is to build it in Voltius and use **Share to
community** on the snippet or folder — it emits exactly this format.

### Variables

`{{name}}` prompts the user. `{{name:type:default}}` does not — a variable with any
default, including an empty one, is never prompted for, with one exception: a
`password`-typed variable always prompts, even with a default, since its value should
never sit in a shared catalogue entry. Types are `text`, `number`, `password`,
`boolean` and `choice` (`{{env:choice:dev,staging,prod}}`). Never gate a mutating
action behind a defaulted variable.

`{{connection.host}}`, `{{connection.username}}`, `{{connection.name}}`, `{{date}}`,
`{{datetime}}`, `{{timestamp}}` and `{{clipboard}}` resolve automatically.

Use a `{{variable}}` for anything host-specific — an IP, an internal hostname, a real
username, or a path that only exists on your machine. Never hardcode it, and never
include a credential, including one you intend to rotate.

### The bar

1. **Don't duplicate the app.** Nothing a built-in panel (snippets, history, themes,
   ports, sftp) or a first-party plugin (process-manager, monitoring, docker, proxmox,
   ssh-config, gist-sync) already does with a button.
2. **POSIX `sh`, no bashisms.** Detect capabilities and degrade: `ss → lsof → netstat`,
   `systemctl → rc-service → service`, `apt-get → dnf → apk → pacman`. Never assume
   systemd or apt.
3. **Show, then act.** A snippet that changes the host prints what it is about to
   touch first, and is idempotent on a second run.
4. **Nothing destructive.** No deleting user data, wiping volumes, or rebooting.
5. **`sudo` only on the line that needs it**, never wrapping the whole script.
6. **Comments explain why.** The preview pane renders them — they are documentation.
7. **Typed variables** where the choice is genuinely the user's.
8. **End with evidence** — a version, a status, a count that proves it worked.

Also out of bounds: piping a remote script into a shell from a URL you do not
control, or from a mutable branch — pin to a release tag where the upstream project
offers one.

### Review checklist

- [ ] Parses, and every `_eid` referenced by a step exists in the same entry
- [ ] Runs on Alpine/busybox, Debian/glibc and a systemd host, or degrades with a clear message
- [ ] Mutating steps are idempotent and print before they act
- [ ] No destructive command, no unexplained network fetch, no credential handling
- [ ] `sudo` scoped to single lines
- [ ] Does not duplicate a panel or first-party plugin
- [ ] Ends by proving it worked
