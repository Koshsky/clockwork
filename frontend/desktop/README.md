# MVS ERP — desktop wrapper (Electron)

Wraps the built vite frontend (`dist/`) into a native desktop application
(Windows / macOS / Linux). The app works online and offline (IndexedDB +
local http) and connects to an external backend via API_URL (set on the
"Synchronization" screen or in the pre-login settings).

## How it works

- `main.js` (main process) starts a local HTTP server on `127.0.0.1` serving
  `../dist` (the built frontend). This is required because the frontend relies
  on root paths `/precache-manifest.json`, `/assets/*` — over `http` they work
  without code changes (unlike `file://`).
- `preload.js` exposes a minimal `window.erpDesktop` API to the renderer via
  `contextBridge` (the `isElectron` flag + safeStorage access for the password).
- There is no Service Worker (it was removed from the project): offline support
  comes from the local http server + IndexedDB (data cache and mutation queue).

## Building

`build-portable.sh` is the recommended way: it **always rebuilds** the
frontend from sources, so the release never embeds a stale `dist/` (see
"Always fresh" below). A manual frontend build is needed only for the plain
`npm run dist*` paths:

```bash
cd ../            # services/frontend
npm run build     # → dist/  (only needed for plain `npm run dist*`)
```

Then build the installers (from `desktop/`):

```bash
npm install        # electron + electron-builder (already in devDependencies)
npm run dist       # all platforms
npm run dist:win   # Windows only (NSIS .exe)
npm run dist:mac   # macOS (dmg + zip)
npm run dist:linux # Linux (AppImage + deb)
```

Ready artifacts go to `release/` (plain `npm run dist` writes to the `release/`
root); `build-portable.sh` additionally lays out each release into a
**per-version directory** `release/<version>/`.

### Always fresh — no cache in build-portable.sh

`build-portable.sh` never reuses a previously built `services/frontend/dist/`;
the Electron wrapper embeds `dist/` into every release (`resources/web` via
`extraResources`), so a reused `dist/` silently shipped an old frontend inside
a new release — the UI kept removed pages and missed recent features while the
artifacts carried the new version. The script therefore:

1. deletes `dist/` and purges the frontend build caches
   (`node_modules/.vite`, `node_modules/.cache`) before every build;
2. builds the web frontend unconditionally with the release version;
3. fails if `dist/precache-manifest.json` was not written with exactly the
   release version (`APP_VERSION` did not reach vite);
4. after packaging, fails if the embedded `resources/web` differs from the
   fresh `dist/`.

The Electron/electron-builder **binary** caches (`desktop/.cache`) are kept on
purpose: they hold tool binaries, not application code.

Useful check when a release "shows old UI": look at
`release/<version>/<app>-unpacked/resources/web/precache-manifest.json` — the
`version` field must equal the release version. A git-hash value (e.g.
`1808c37-mtx0hk8x`) means a stale bundle was embedded.

### Portable + single-file — Windows and Linux

`build-portable.sh` builds a release with a **version**. All artifacts of one
version live in a single directory `release/<version>/`, e.g.:

```
release/1.0.2/
├── MVS ERP-1.0.2-linux-x86_64.AppImage   # Linux single file
├── MVS ERP-1.0.2-win-x64.exe             # Windows single self-contained .exe
├── MVS ERP-1.0.2-win-x64.zip             # Windows portable archive
├── linux-unpacked/                       # Linux portable folder
└── win-unpacked/                         # Windows portable folder
```

Each of the **4 parts** of a release is toggled by its own flag; **Linux is
enabled by default, Windows disabled**. Explicit flags add parts to the Linux
default:

| Part | Artifacts | Flag | Default |
|---|---|---|---|
| Linux portable | `linux-unpacked/` | `--linux-portable` | on |
| Linux single-file | `*-linux-x86_64.AppImage` | `--linux-appimage` | on |
| Windows portable | `win-unpacked/` + `*-win-x64.zip` | `--win-portable` | off |
| Windows single-file | `*-win-x64.exe` (best-effort) | `--win-exe` | off |

Shorthands: `--win` = `--win-portable --win-exe`; `--linux` = both Linux flags.

The **version is shared by the web frontend and the desktop wrapper**: the
single source of truth is `services/frontend/package.json` (semver).
`desktop/package.json` is synced to the same version automatically on every
build, so the wrapper package and the artifacts can never drift from the web
version. The build always uses the **current version as is** — the script
never bumps it (there is no `--bump`); change `package.json` yourself when
releasing:

```bash
./build-portable.sh                 # Linux (both parts), version = current from package.json
./build-portable.sh --win           # Linux + both Windows parts
./build-portable.sh --win-portable  # Linux + Windows portable (zip + folder)
./build-portable.sh --win-exe       # Linux + single-file Windows .exe
./build-portable.sh --version 2.1.0 # build exactly 2.1.0 (no source change)
./build-portable.sh --clean         # clean release/ before building
./build-portable.sh --build-web     # deprecated no-op: web is always rebuilt
```

`--version` builds an exact version without writing it into the source
(`services/frontend/package.json` stays untouched; `desktop/package.json` is
still synced so the wrapper matches the artifacts). The next default build
continues from the source version.

The version is passed into the web build (`APP_VERSION` → `__APP_VERSION__` and
`precache-manifest.json`) and into electron-builder
(`-c.extraMetadata.version`), so "App/build version" on the "Synchronization"
screen matches the artifact version. The script does not commit the version —
commit the increment separately (e.g. `chore: release vX.Y.Z`).

Portable targets do not need wine: `zip`/`dir`/portable/AppImage are built on
a Linux host. The single-file Windows `.exe` (the `portable` target) is built
in a separate invocation; if the environment cannot build it, the script
continues with zip and prints a warning. (The NSIS `.exe` installer is NOT
portable; it needs wine + makensis on Linux — that is a separate
`npm run dist:win`.)

Dev run (without packaging):

```bash
npm start          # opens an Electron window with the locally served dist/
```

## Auto-sync password

The auto-sync password is stored **not in the browser** but in the main
process via `safeStorage` (OS-level encryption, file in `userData`), and the
renderer can only access it over IPC
(`window.erpDesktop.password.get/set/clear`). In a plain browser (non-Electron)
the password is not stored at all.

Auto-sync credentials **are saved automatically at login** (on the login page):
the login to localStorage, the password to safeStorage; there is no separate
input on the "Synchronization" screen. On startup the app automatically
restores the session from the saved credentials
(`ensureDesktopAutoSyncSession` in `src/offline/sync.ts`) if auto-sync is
enabled and no session exists — and syncs without a manual login. After an
explicit "Log out", auto-sync does not log in again until the next manual
login. Without a network, the login page offers "Log in offline" — a local
session with cache and a mutation queue.

## Requirements

- Node.js ≥ 20 (for build/packaging).
- Building the macOS installer requires macOS; the Windows .exe is easier to
  build on Windows (electron-builder can cross-build with limitations).
- safeStorage works where the OS provides encryption (macOS Keychain, Windows
  DPAPI, Linux — keyring); if no key is available, the password is simply not
  saved.