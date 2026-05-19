# Voltius Plugin Marketplace

The official plugin registry for [Voltius](https://github.com/voltiusApp/voltius) — Open-Source SSH & SFTP Client built with Tauri, React, and Rust.

## For users

Browse and install plugins directly from the **Settings → Plugins → Browse** tab in Voltius. No account required.

---

## For plugin authors

This guide covers everything you need to publish a plugin to the marketplace.

### Quickstart

A Voltius plugin is a **single bundled JavaScript file** (`index.js`) plus a `manifest.json`. Zero Rust required.

```
my-plugin/
├── manifest.json
├── src/
│   └── index.ts
├── package.json
└── tsconfig.json   (optional)
```

### 1. Manifest

`manifest.json` describes your plugin to the runtime:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What your plugin does.",
  "permissions": ["connections:read", "http", "notifications"],
  "defaultEnabled": false,
  "contributes": {
    "configuration": {
      "apiKey": {
        "type": "string",
        "default": "",
        "description": "Your API key",
        "secret": true
      },
      "pollInterval": {
        "type": "number",
        "default": 30,
        "description": "Poll interval in seconds"
      }
    }
  }
}
```

**Fields**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier. Use `kebab-case`. Must match the folder name when installed locally. |
| `name` | yes | Human-readable name shown in the UI. |
| `version` | yes | Semver string. |
| `description` | no | Short description shown in the marketplace. |
| `permissions` | yes | List of capabilities your plugin needs (see [Permissions](#permissions)). |
| `defaultEnabled` | no | `true` only for first-party bundled plugins. Leave unset or `false` for marketplace plugins. |
| `contributes.configuration` | no | Declarative settings schema. Fields are auto-populated with defaults on first load and rendered as a form in the Plugins settings page if no custom settings page is registered. |

### 2. Entry point

Export a single `register` function as the default export:

```typescript
import type { PluginAPI } from "@Voltius/plugin-types"; // community types package

export default function register(api: PluginAPI): (() => void) | void {
  // setup...

  return () => {
    // cleanup: called when plugin is disabled or app closes
  };
}
```

The cleanup function is optional but recommended if you set up subscriptions, intervals, or event listeners.

### 3. Build

Bundle everything into a single `index.js`. esbuild is the easiest option:

```bash
npm install --save-dev esbuild
npx esbuild src/index.ts \
  --bundle \
  --platform=browser \
  --format=esm \
  --external:react \
  --external:react-dom \
  --outfile=dist/index.js
```

React is externalized because it's provided by the host app.

A minimal `package.json`:

```json
{
  "name": "Voltius-plugin-my-plugin",
  "version": "1.0.0",
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=browser --format=esm --external:react --external:react-dom --outfile=dist/index.js"
  },
  "devDependencies": {
    "esbuild": "^0.21.0"
  }
}
```

### 4. Plugin API reference

The `PluginAPI` object is passed to your `register` function and is the only interface to the host app.

#### `api.pluginId` — `string`

Your plugin's ID as declared in `manifest.json`.

#### `api.isActive()` — `() => boolean`

Returns `true` if the plugin is currently enabled. Use this in `register()` to skip setup when disabled:

```typescript
export default function register(api: PluginAPI) {
  if (!api.isActive()) return; // plugin is disabled — do nothing
  // ...
}
```

---

#### `api.connections` — requires `connections:read` / `connections:write`

```typescript
api.connections.list()                                   // Promise<PluginConnection[]>
api.connections.get(id)                                  // Promise<PluginConnection | null>
api.connections.create(data: PluginConnectionInput)      // Promise<PluginConnection>
api.connections.update(id, data)                         // Promise<void>
api.connections.delete(id)                               // Promise<void>
api.connections.bulkImport(items)                        // Promise<PluginConnection[]>
api.connections.subscribe(cb)                            // () => void  (unsubscribe)
```

`PluginConnection` shape:

```typescript
interface PluginConnection {
  id: string;
  name?: string;
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "key";
  tags: string[];
  identity_id?: string;
  jump_hosts?: JumpHost[];
}
```

---

#### `api.keys` — requires `keys:read` / `keys:write`

```typescript
api.keys.list()                                          // Promise<PluginKey[]>
api.keys.create(data, privateKey, publicKey?)            // Promise<PluginKey>
api.keys.delete(id)                                      // Promise<void>
```

---

#### `api.identities` — requires `identities:read` / `identities:write`

```typescript
api.identities.list()                                    // Promise<PluginIdentity[]>
api.identities.create({ name?, username, key_id? })      // Promise<PluginIdentity>
api.identities.delete(id)                                // Promise<void>
```

---

#### `api.vault` — requires `vault:read` / `vault:write`

Encrypted key-value store for secrets. Scoped to your plugin — keys are stored as `plugin:<id>:<key>` and are never accessible to other plugins.

```typescript
api.vault.get(key)           // Promise<string | null>
api.vault.set(key, value)    // Promise<void>
api.vault.delete(key)        // Promise<void>
```

Use `vault` for sensitive data (tokens, passwords). Use `storage` for non-sensitive config.

---

#### `api.storage` — always available

JSON key-value store persisted to disk (`$APP_DATA/plugin-data/<id>.json`). Not encrypted. If a key matches a field declared in `contributes.configuration`, the value is type-checked and a `PluginTypeError` is thrown on mismatch.

```typescript
api.storage.get<T>(key)      // Promise<T | null>
api.storage.set<T>(key, val) // Promise<void>
api.storage.delete(key)      // Promise<void>
```

---

#### `api.omni` — requires `omni-commands`

Register commands in the Command Palette (Cmd+K / Ctrl+K):

```typescript
api.omni.register({
  id: "my-cmd",
  label: "Do something",
  icon: "lucide:zap",           // Iconify icon ID
  keywords: ["something", "do"],
  section: "My Plugin",
  keybinding: "ctrl+shift+d",   // optional, first-registered wins on conflict
  execute: async () => { /* ... */ },
})  // returns () => void cleanup
```

---

#### `api.ui` — requires matching permission per slot

```typescript
// Requires "settings-page"
api.ui.registerSettingsPage({ id, label, icon, component: React.FC })

// Requires "sidebar-item"
api.ui.registerSidebarItem({ id, label, icon, component: React.FC, position?: "top" | "bottom" })

// Requires "right-panel"
api.ui.registerRightPanelSection({ id, label, icon, component: React.FC })

// Requires "context-menu"
api.ui.registerContextMenuItem({
  id, label, icon?,
  target: "connection" | "session" | "tab" | Array,
  action: (ctx: ContextMenuContext) => void,
})

// Requires "ui-contributions"
api.ui.registerContribution(slot, (ctx) => ContributedAction[])
```

All register methods return a cleanup function. Available `UISlot` values:

```
"connection.contextMenu"    "connection.panelActions"
"key.contextMenu"           "key.panelActions"
"identity.contextMenu"      "identity.panelActions"
"home.bgContextMenu"        "keychain.bgContextMenu"
"home.toolbar.hostMenu"     "settings.vaults"
```

`ContributedAction`:

```typescript
interface ContributedAction {
  label: string;
  icon?: string;
  onClick: () => void;
  divider?: boolean;
  danger?: boolean;
  shortcut?: string;
  when?: (context: unknown) => boolean; // sync only — errors treated as false
}
```

---

#### `api.themes` — requires `themes`

```typescript
api.themes.register(theme: PluginTheme)  // same shape as AppTheme
api.themes.unregister(id: string)
```

---

#### `api.sessions` — requires `sessions:read` / `sessions:write`

```typescript
api.sessions.list()                          // PluginSession[]  (snapshot)
api.sessions.onConnected(cb)                 // () => void
api.sessions.onDisconnected(cb)              // () => void
api.sessions.onActivated(cb)                 // () => void  (tab switch)
api.sessions.sendCommand(sessionId, cmd)     // Promise<void>  — requires sessions:write
```

`sendCommand` writes to the terminal. The runtime appends `\n`. Works for both SSH sessions and local shells.

> **Note:** `sendCommand` is intentionally powerful. Users are responsible for the plugins they install.

---

#### `api.lifecycle` — always available

```typescript
api.lifecycle.onConnectionEstablished(cb)   // fires when a session becomes "connected"
api.lifecycle.onConnectionClosed(cb)        // fires on disconnect / removal
api.lifecycle.onSessionActivated(cb)        // fires on active tab change
api.lifecycle.onSettingsChanged(cb)         // fires when storage.set() is called for this plugin
api.lifecycle.onBeforeQuit(cb)              // max 5s before app force-quits
```

All return a cleanup `() => void`.

---

#### `api.http` — requires `http`

```typescript
api.http.get<T>(url, opts?)         // Promise<T>  — throws on non-2xx
api.http.post<T>(url, body, opts?)  // Promise<T>  — sets Content-Type: application/json
```

---

#### `api.fs` — requires `fs`

Paths are relative to the user's home directory.

```typescript
api.fs.readText(path)                          // Promise<string>
api.fs.writeText(path, content)                // Promise<void>
api.fs.exists(path)                            // Promise<boolean>
api.fs.watch(path, cb, { intervalMs?: number }) // () => void  (polling-based)
```

---

#### `api.notifications` — requires `notifications`

```typescript
api.notifications.toast(message, {
  severity?: "info" | "success" | "warning" | "error",
  duration?: number,   // ms, default 2500
  action?: { label: string; onClick: () => void },
})

const progress = api.notifications.progress("Uploading...", {
  indeterminate?: boolean,   // default true
  cancellable?: boolean,
})
progress.update(50, "Halfway there")
progress.finish("Done!")
progress.error("Something went wrong")

const banner = api.notifications.banner("Update available", {
  severity?: "info" | "success" | "warning" | "error",
  actions?: Array<{ label: string; onClick: () => void }>,
  dismissable?: boolean,
  flashToast?: boolean,  // also shows a toast, default true
})
banner.dismiss()
banner.update("New message")
```

---

#### `api.sync` — requires `sync:read` / `sync:write`

Binary blob storage for sync scenarios. Max 1 MB per blob.

```typescript
api.sync.getBlob(key)           // Promise<Uint8Array | null>
api.sync.setBlob(key, data)     // Promise<void>  — throws PluginStorageError if > 1MB
api.sync.onRemoteChange(key, cb) // () => void  — fires after sync if blob changed
api.sync.triggerReload(storeKey) // Promise<void>  — storeKey: "connections"|"identities"|"keys"|"snippets"|"folders"
api.sync.exportState(encKey, deviceId) // Promise<string>  — base64 encrypted blob
api.sync.importStates(encKey, blobs)   // Promise<void>   — CRDT-merge remote blobs
```

---

#### `api.events` — always available

Shared event bus across all plugins. Emitted events are prefixed with the plugin ID automatically (`<pluginId>:<event>`). Listen to another plugin's events using the full prefixed name.

```typescript
// Plugin A emits
api.events.emit("synced", { count: 5 })
// → fires handlers for "plugin-a:synced"

// Plugin B listens
api.events.on("plugin-a:synced", (data) => { /* ... */ })
```

---

#### `api.plugins` — always available

Inter-plugin communication:

```typescript
api.plugins.expose({ doThing: () => {} })          // publish your surface
api.plugins.getApi("other-plugin-id")              // unknown | null
```

---

#### `api.log` — always available

Console output scoped to your plugin (`[plugin:<id>]` prefix):

```typescript
api.log.info("message", ...args)
api.log.warn("message", ...args)
api.log.error("message", ...args)
```

---

### Permissions reference

Declare these in `manifest.json` under `"permissions"`. The runtime throws if you call an API without the required permission.

| Permission | Unlocks |
|------------|---------|
| `connections:read` | `connections.list/get/subscribe` |
| `connections:write` | `connections.create/update/delete/bulkImport` |
| `keys:read` | `keys.list` |
| `keys:write` | `keys.create/delete` |
| `identities:read` | `identities.list` |
| `identities:write` | `identities.create/delete` |
| `vault:read` | `vault.get` |
| `vault:write` | `vault.set/delete` |
| `http` | `http.get/post` |
| `fs` | `fs.readText/writeText/exists/watch` |
| `themes` | `themes.register/unregister` |
| `omni-commands` | `omni.register/unregister` |
| `settings-page` | `ui.registerSettingsPage` |
| `sidebar-item` | `ui.registerSidebarItem` |
| `right-panel` | `ui.registerRightPanelSection` |
| `context-menu` | `ui.registerContextMenuItem` |
| `ui-contributions` | `ui.registerContribution` |
| `notifications` | `notifications.toast/progress/banner` |
| `sessions:read` | `sessions.list/onConnected/onDisconnected/onActivated` |
| `sessions:write` | `sessions.sendCommand` |
| `sync:read` | `sync.getBlob/onRemoteChange/triggerReload` |
| `sync:write` | `sync.setBlob/exportState/importStates` |

`api.storage`, `api.events`, `api.log`, `api.plugins`, and `api.lifecycle` are **always available** — no permission needed.

---

### Complete example: SSH Config importer

```typescript
// src/index.ts
import type { PluginAPI } from "@Voltius/plugin-types";

export default function register(api: PluginAPI) {
  if (!api.isActive()) return;

  const unregister = api.omni.register({
    id: "import-ssh-config",
    label: "Import ~/.ssh/config",
    icon: "lucide:file-input",
    section: "Import",
    async execute() {
      const raw = await api.fs.readText(".ssh/config");
      const hosts = parseSshConfig(raw);
      const existing = await api.connections.list();

      const toImport = hosts.filter(
        (h) => !existing.some((e) => e.host === h.host && e.username === h.username)
      );

      if (toImport.length === 0) {
        api.notifications.toast("No new hosts found", { severity: "info" });
        return;
      }

      const progress = api.notifications.progress(`Importing ${toImport.length} hosts…`);
      try {
        await api.connections.bulkImport(toImport);
        progress.finish(`Imported ${toImport.length} hosts`);
      } catch (e) {
        progress.error(String(e));
      }
    },
  });

  return () => {
    unregister();
  };
}

function parseSshConfig(raw: string) {
  // parse ~/.ssh/config format into PluginConnectionInput[]
  // ...
}
```

---

### Complete example: Theme plugin

```typescript
import type { PluginAPI } from "@Voltius/plugin-types";

export default function register(api: PluginAPI) {
  if (!api.isActive()) return;

  api.themes.register({
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    fontFamily: "JetBrains Mono",
    fontSize: 13,
    ui: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      // ... full UITheme
    },
    terminal: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      // ... full TerminalTheme
    },
  });

  return () => {
    api.themes.unregister("catppuccin-mocha");
  };
}
```

---

### Complete example: Docker manager (side panel)

```typescript
import type { PluginAPI } from "@Voltius/plugin-types";

export default function register(api: PluginAPI) {
  if (!api.isActive()) return;

  const cleanups: Array<() => void> = [];

  cleanups.push(
    api.ui.registerRightPanelSection({
      id: "docker-panel",
      label: "Docker",
      icon: "logos:docker-icon",
      component: DockerPanel, // React.FC — receives no props, use closure over api
    })
  );

  cleanups.push(
    api.lifecycle.onConnectionEstablished((conn) => {
      api.log.info(`Connection established: ${conn.host}`);
    })
  );

  return () => cleanups.forEach((fn) => fn());
}
```

---

### Local development

1. Build your plugin:
   ```bash
   npm run build   # → dist/index.js
   ```

2. Find your app data directory:
   - **Windows:** `%APPDATA%\Voltius\`
   - **macOS:** `~/Library/Application Support/Voltius/`
   - **Linux:** `~/.config/Voltius/`

3. Create the plugin folder:
   ```
   $APP_DATA/plugins/my-plugin/
   ├── manifest.json
   └── index.js
   ```

4. Start Voltius — your plugin loads automatically on the next startup.

5. To reload after changes: go to **Settings → Plugins → Installed** and click **Reload** on your plugin. No restart needed.

---

### Publishing to the marketplace

1. **Create a GitHub repo** for your plugin (e.g. `acme/Voltius-plugin-my-plugin`).

2. **Create a GitHub Release** with two assets:
   - `index.js` — your compiled bundle
   - `manifest.json` — your plugin manifest

   The marketplace fetches `https://github.com/{owner}/{repo}/releases/latest/download/index.js` and `manifest.json` automatically.

3. **Submit a PR** to this repo adding an entry to `plugins.json`:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "author": "acme",
  "description": "What it does in one sentence.",
  "repo": "acme/Voltius-plugin-my-plugin",
  "version": "1.0.0",
  "minAppVersion": "0.1.0",
  "tags": ["productivity", "import"],
  "theme": false
}
```

For theme plugins, set `"theme": true` — it's listed in the same Browse tab.

#### `plugins.json` field reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Must match `manifest.json` `id` |
| `name` | yes | Display name |
| `author` | yes | GitHub username or org |
| `description` | yes | One sentence |
| `repo` | yes | `owner/repo` on GitHub, or a direct URL to the bundle |
| `version` | yes | Latest release version |
| `minAppVersion` | no | Minimum Voltius version required |
| `tags` | yes | 1–5 lowercase tags for filtering |
| `theme` | yes | `true` if this is a theme-only plugin |

#### Review criteria

- `manifest.json` `id` matches the `plugins.json` entry `id`
- Plugin loads without errors (test locally before submitting)
- Permissions in `manifest.json` match what the code actually uses
- Description is accurate and in English
- No malicious or deceptive behavior

---

### What plugins cannot do

These are hard limits enforced by the runtime — not accessible through `PluginAPI` by design:

- Access active SSH session I/O or terminal output
- Inject keystrokes into a terminal channel
- Create SSH tunnels (`direct-tcpip`)
- Read another plugin's vault secrets
- Access the core Stronghold vault directly
- Call Tauri commands not exposed through `PluginAPI`

---

### Sync plugin exclusivity

Only one sync plugin can be active at a time. If your plugin implements sync, declare `"syncPlugin": true` in `manifest.json`. The runtime enforces that at most one sync plugin is enabled — activating yours automatically disables the currently active sync plugin after exporting its data.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The simplest contribution is adding your plugin to `plugins.json` via a PR.
