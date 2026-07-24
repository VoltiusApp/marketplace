# Contributing to the Voltius Plugin Marketplace

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

**Before submitting, stamp your entry's hash:**

```sh
node scripts/stamp-hashes.mjs        # writes the correct hash into every entry
node scripts/stamp-hashes.mjs --check  # what CI runs; must pass
```

The script resolves each entry's `index.js` exactly as the client does — hashing the in-repo file
for plugins served from this repo's `raw.githubusercontent.com/.../marketplace/...` tree, or fetching
the release asset for external plugins. CI runs `--check` on every PR and on `main`; a missing or
wrong hash fails the check. Re-run `stamp-hashes.mjs` and commit whenever you ship a new bundle.
