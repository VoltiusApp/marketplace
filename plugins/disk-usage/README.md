# Disk Usage (Voltius plugin)

Find what fills a disk without leaving Voltius. Pick a folder on the active SSH host (or this
computer, for a local terminal), scan it, and drill into the biggest directories and files from a
treemap and a sorted list. On desktop it lives in the session side panel; on a phone it is in the
terminal's Panels sheet, with touch-sized rows.

## How it works

Everything runs through `api.host` (permission `host:exec`). These are the only commands it sends:

| When | Command |
|------|---------|
| Scan | `du -xk -- <folder>`, under `nice -n 19` and, where available, `ionice -c3` |
| Open a folder | `find <folder> -maxdepth 1 -type f -exec du -k {} +` — the regular files directly inside |
| Home button | `printf %s "$HOME"` |

Each one is wrapped as `sh -c '<script>' sh <folder>`, with the folder passed as a single-quoted
argument, so the folder name never becomes shell syntax and a fish or zsh login shell on the host
never parses the script.

- `-x` keeps the scan on the folder's own filesystem: scanning `/` does not walk `/proc` or network mounts.
- Sizes are disk usage (allocated blocks, KiB), which is what a full disk is about. A sparse file counts
  for what it occupies, not its apparent length.
- `du` prints children before parents, so the tree fills in while the scan runs, and folders whose
  totals have not arrived yet show the sum of what has been seen inside them so far.
- Folders the account cannot read are counted and reported. Their contents are missing from the totals.
- Read-only: the plugin never deletes, moves or writes anything.

## Requirements

- Voltius 0.76.0 or later (`api.host`).
- A POSIX `sh`, `du` and `find` on the host: Linux (GNU or busybox), macOS and the BSDs. Windows hosts
  are not supported yet.

## Develop

```sh
npm run build      # bundles src/ into index.js
npm run typecheck
npm test
```
