# kelo

> Hot updates for Electron apps — push compiled JS/asset bundles to running apps in ~5 seconds. No installer rebuild, no app-store round-trip.

kelo gives an Electron app two update channels:

- **`kelo update`** — a **hot update**: ship your built JS/assets (`dist/`, `dist-electron/`) to running apps in seconds. Great for bug fixes and feature tweaks.
- **`kelo publish`** — a **full release**: build a real installer with `electron-builder` and an `electron-updater` feed, for when native code or Electron itself changes.

It's open source (MIT) and **backend-agnostic-by-convention**: you build locally (or in CI) and upload to your own storage. The reference backend is Supabase (a `kelo_releases` table + a Storage bucket), which you can self-host.

---

## Install

```sh
npm install kelo
```

## Quick start (CLI)

```sh
npx kelo init        # writes kelo.config.json and prints the table schema
# set the write key (server/CI only — never ship this in the app):
export KELO_SUPABASE_KEY="<service-role key>"

npx kelo update      # build -> zip -> sha256 -> upload -> record a hot update
npx kelo publish     # build a full installer + updater feed (runs on the target OS)
npx kelo status      # show the latest version
```

`kelo init` creates `kelo.config.json`:

```json
{
  "supabaseUrl": "https://<your-project>.supabase.co",
  "bucket": "prod",
  "include": ["dist", "dist-electron"],
  "buildCommand": "npx vite build"
}
```

It also prints the SQL for the releases table:

```sql
CREATE TABLE kelo_releases (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  version TEXT NOT NULL,
  download_url TEXT NOT NULL,
  sha256 TEXT,
  release_type TEXT NOT NULL DEFAULT 'update',
  platform TEXT NOT NULL DEFAULT 'mac',
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Add a Storage bucket (default name `prod`) with public read, and an RLS policy that lets your **anon** key read `kelo_releases`.

---

## Wire it into your app

kelo assumes your build outputs the Electron main process to `dist-electron/main.js` and the renderer to `dist/` (the defaults for a Vite + Electron setup).

### 1. Point your entry at the launcher

The launcher is the one file that never gets hot-updated; it loads the hot `main.js` if present, otherwise the bundled one, with a crash failsafe.

```jsonc
// package.json
{
  "main": "node_modules/kelo/dist/launcher.cjs"
}
```

### 2. Start the updater in the main process

```js
// dist-electron/main.js (your Electron main)
import { app } from 'electron'
import { createKeloUpdater } from 'kelo'

app.whenReady().then(() => {
  createKeloUpdater({
    supabaseUrl: 'https://<your-project>.supabase.co',
    supabaseKey: process.env.MY_ANON_KEY, // a READ-only anon key — safe to ship
    bucket: 'prod',
    checkInterval: 5 * 60 * 1000, // optional; default 5 min
  })
  // ...create your BrowserWindow as usual
})
```

> **Key safety:** the client uses a read-only **anon** key. The **service-role** key (`KELO_SUPABASE_KEY`) is for `kelo update` / `kelo publish` only and must stay on your machine or CI — never bundle it in the app.

### 3. Expose the IPC bridge in your preload

```js
// preload.js
const { contextBridge, ipcRenderer } = require('electron')
const bridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, handler) => {
    const listener = (_e, ...a) => handler(...a)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
}
contextBridge.exposeInMainWorld('electronAPI', { ...bridge, kelo: bridge })
```

The renderer hook looks for the bridge at `window.electronAPI.kelo` or `window.kelo`.

### 4. Show update UI in the renderer (React)

```jsx
import { useKeloUpdate } from 'kelo/react'

function UpdateBanner() {
  const { available, version, downloading, progress, download } = useKeloUpdate()
  if (!available) return null
  return (
    <button onClick={download} disabled={downloading}>
      {downloading ? `Updating… ${progress}%` : `Update to ${version}`}
    </button>
  )
}
```

Calling `download()` downloads, verifies (sha256), extracts, and relaunches into the new code.

---

## How an update is trusted

- The bundle's **sha256** is recorded on push and verified on the client before extraction.
- The download URL must match the configured `supabaseUrl` origin.
- Extraction is guarded against zip-slip (path traversal).

> Roadmap: asymmetric **update signing** (sign on push, verify with an embedded public key) is planned before 1.0. Until then, treat write access to your bucket as equivalent to code execution in the app, and lock it down accordingly.

## Config reference

| Field | Where | Meaning |
|---|---|---|
| `supabaseUrl` | config + client | Your project origin |
| `supabaseKey` | client (anon) / `KELO_SUPABASE_KEY` env (service, CLI) | Read key in the app; write key for the CLI |
| `bucket` | config | Storage bucket (default `prod`) |
| `include` | config | Dirs zipped into a hot update (default `["dist", "dist-electron"]`) |
| `buildCommand` | config | Build step run before packaging (default `npx vite build`) |
| `platform` | config / `--windows` / `--mac` | Target platform |

---

## Development

```sh
npm install
npm run build         # bundle with tsup
npm test              # unit tests for the security-critical guards
npm run test:e2e:cli  # update upload round-trip against an in-memory backend
npm run test:e2e      # full packaged-Electron E2E (update + publish)
```

CI runs the unit tests plus the full `update`/`publish` E2E on `macos-latest` and `windows-latest` for every push and PR.

### Branch workflow

`main` is protected and **PR-only**. Do work on `dev` (or a feature branch off `dev`) and open a PR; PRs are **squash-merged** so each change lands on `main` as one commit. After a squash-merge, `dev` has divergent history but identical content — resync it:

```sh
git checkout dev && git fetch && git reset --hard origin/main && git push --force-with-lease origin dev
```

## License

MIT
