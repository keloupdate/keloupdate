# Spec: Automated testing for kelo

Status: draft for implementation
Owner: hand to a terminal as a spec-driven task

## Goal

Prove that the two cross-platform code paths work on both target OSes before any
release: **publishing a bundle** (`kelo push`) and **applying a hot update** (the
client updater). "Don't ship bad code" = these tests pass on `macos-latest` and
`windows-latest` on every PR, with no Supabase credentials and no servers.

## Scope correction (read first)

- `kelo publish` is a **stub in this repo** (`src/cli.ts` prints "not yet
  implemented"), but a **working reference implementation exists** and should be
  ported and generalized (see "Publish: reference implementation" below).
- Two distinct publishable paths therefore exist:
  - **`kelo push`** — hot-update bundle (JS/asset zip). Already implemented here.
  - **`kelo publish`** — full installer via electron-builder + the electron-updater
    feed (yml/blockmap/zip). To be ported.
- Test scenarios:
  - "update windows / update mac" → the client updater applying a hot bundle.
  - "publish windows / publish mac" → `push` (bundle) now, and `publish` (installer)
    once ported. Unsigned electron-builder runs on hosted runners (Tier 2); real
    codesign/notarize needs the fleet (Tier 3).

## Publish: target implementation

`publish` is currently a stub. Implement it in `src/cli.ts` as a config-driven flow
(no hardcoded URL, no product name, optional native-deps hook, table
`kelo_releases`), and build in the defect guards listed below from the start.

Flow:
1. Bump version from the releases table (or `--version`).
2. Temp-write version into `package.json` (electron-builder reads it); **restore on
   every exit path**, including failure, so git stays clean.
3. install deps → vite build → (optional native-deps hook) → `electron-builder
   --win`/`--mac --config.npmRebuild=false`.
4. Locate the installer across `dist/` (electron-builder v26+) and
   `release/<version>/` (older), with filename candidates + a glob fallback.
5. Upload installer → insert release row (`release_type: "publish"`).
6. Upload the electron-updater feed: Windows → `latest.yml` + `.exe.blockmap`;
   Mac → `-mac.zip` + `latest-mac.yml`.

Defect guards to build in:
- **No "must run on the target OS" guard for publish.** The hot-update path guards
  cross-compile; the publish path does not, so `publish windows` run on macOS builds
  the wrong-arch native binary and electron-builder fails. Add an explicit guard /
  clear error when `process.platform` does not match the target.
- **Undefined variable in the "installer not found" error path** (a stale
  `releaseDir` reference) → throws `ReferenceError` instead of the intended message,
  masking the real failure. Use the actual search-dirs variable.
- **Stale Windows installer filename candidates** that don't match the nsis
  `artifactName` (`${productName}-Setup-${version}.${ext}`); only the glob fallback
  saves it. Align candidates with `artifactName`.
- **Inconsistent restore-on-failure**: one failure branch exits without restoring
  `package.json`. Route every failure through the restore path.

## The OS-divergent surfaces the tests must actually exercise

These are the only lines that differ by OS — every test below exists to cover one
of them:

| Surface | Windows | Mac | File |
|---|---|---|---|
| Zip creation | `Compress-Archive` | `zip -r … -x "*.map"` | `cli.ts:232-237` |
| Extraction | `Expand-Archive` | `unzip -o` | `updater.ts:171-175` |
| Quarantine cleanup | (none) | `xattr -d com.apple.quarantine` | `updater.ts:179-188` |
| node_modules link | `symlink … 'junction'` | symlink | `launcher.cts:86` |

Known discrepancy to assert on, not paper over: **Windows includes `.map` files in
the bundle, Mac excludes them.** A test should make this explicit so the difference
is intentional, not accidental.

## Tiers

### Tier 1 — Pure unit (every push, all OSes, milliseconds)

Security-critical pure functions. A silent bug here ships broken or malicious code,
so this tier is non-negotiable and must run first.

Functions to cover:
- `compareVersions`, `isValidVersion` (updater) and `bumpVersion`, `getBumpType` (cli)
- `verifyAllFilesWithin` — zip-slip guard (`updater.ts:85`)
- The download-origin check: URL must `startsWith(config.supabaseUrl + '/')`
  (`updater.ts:108`)
- sha256 mismatch → failure (`updater.ts:148`)
- `SAFE_DIR_NAME` include-dir validation (`cli.ts:23,53`)

**Prerequisite refactor (for the implementer):** these helpers are currently not
exported, and `updater.ts` imports `electron` at module top. To unit-test without
Electron, either (a) extract the pure helpers into `src/internal.ts` with no
electron import and re-export, or (b) test through a subpath with `electron` mocked.
Prefer (a) — it is cleaner and the security guards deserve to be independently
importable. Flag any larger refactor back before doing it.

Runner: `node --test` (or vitest) on the Linux runner is enough; logic is OS-agnostic.

### Tier 2 — Cross-platform E2E (free, no servers, the core of this spec)

A GitHub Actions matrix `[macos-latest, windows-latest]` running the **full
push → update loop** against a **local fake backend**. This is the kelo analog of
Expo's Maestro tests: drive the real packaged app and observe behavior, no internal
test hooks trusted.

#### Fake backend (test harness)

A small local HTTP server (Node `http`, started by the test on `127.0.0.1:<port>`)
implementing only the endpoints the code touches. Set `config.supabaseUrl` to
`http://127.0.0.1:<port>` so the origin check passes and no real Supabase or secret
is involved.

Endpoints required:
- `GET /rest/v1/kelo_releases?…` → returns the seeded latest release row(s)
  (used by both `cli.getLatestVersion` and `updater.checkForUpdate`).
- `POST /rest/v1/kelo_releases` → records the inserted release in memory, 201.
- `POST /storage/v1/upload/resumable` (+ TUS PATCH/HEAD) → accept the TUS upload,
  store the bytes in memory keyed by object path. (Use a minimal TUS server impl;
  `tus-js-client` is the client, so the server must speak the TUS core protocol.)
- `GET /storage/v1/object/public/<bucket>/<path>` → serve the stored bytes.

This single server lets `push` upload and `update` download the **same bytes**,
which is the whole point of the round-trip.

> Fidelity note: a higher-fidelity alternative is `supabase start` (real local
> stack, real Storage/TUS) run nightly. Keep that optional — the in-memory mock is
> hermetic, fast, and sufficient for every-PR signal.

#### Fixture Electron app

`test/fixtures/app/` — a minimal Electron app:
- `package.json` version `1.0.0`, `main` pointing at kelo's `launcher.cjs`.
- `main.js` calls `createKeloUpdater(config)` and creates a window.
- `preload.js` exposes `electronAPI.invoke/on` over the `kelo:*` channels.
- renderer renders `getCurrentVersion()` into the DOM and writes it to a marker
  file in `userData` on boot (observable oracle for the relaunch assertion).

The "new" v1.0.1 bundle = the same app with version bumped and a visible marker
change, produced by running `kelo push` in the test (Windows path uses
`Compress-Archive`, Mac uses `zip`).

Driver: Playwright's Electron support (`_electron.launch`) — the desktop equivalent
of Maestro/Detox. Launches the packaged app, evaluates in main + renderer, can
relaunch.

#### Test cases (per OS in the matrix)

**P1 — push produces a valid, verifiable bundle**
1. Run `kelo push` (with `--windows`/`--mac` as appropriate) against the fake backend.
2. Assert: a release row was inserted with a `sha256`, and the stored object's
   bytes hash to that same `sha256`.
3. Assert bundle contents include `dist-electron/main.js`; assert the `.map`
   inclusion/exclusion matches the platform rule (present on Windows, absent on Mac).

**P2 — publish builds a real installer + valid updater feed (after port)**
1. On the matching hosted runner (`windows-latest` / `macos-latest`), run `kelo
   publish <platform>` with **electron-builder unsigned** (no certs).
2. Assert: the installer artifact is located (covers the artifact-discovery +
   filename-candidate logic), a `release_type: "publish"` row is inserted, and the
   electron-updater feed is uploaded — Windows: `latest.yml` (+ `.exe.blockmap` if
   present); Mac: `-mac.zip` + `latest-mac.yml`.
3. Assert `package.json` version is **restored** after both success and an injected
   failure (covers the restore-on-failure defect).
4. Assert the cross-OS guard: `publish windows` invoked on macOS fails fast with a
   clear message rather than building the wrong-arch binary.

**U1 — update downloads, verifies, and lands on disk**
1. Seed the backend with the v1.0.1 release from P1. Launch the v1.0.0 fixture app.
2. Drive `kelo:check` then `kelo:download` through the preload bridge.
3. Assert `downloadAndApply` returned success, `hotUpdateDir/version.txt === 1.0.1`,
   `hotUpdateDir/dist-electron/main.js` exists, and (Mac) no quarantine xattr remains.

**U2 — relaunch loads the hot-updated code**
1. After U1, close the app and launch the fixture app fresh (second
   `_electron.launch`).
2. Assert `launcher.cts` chose the hot main.js and `getCurrentVersion() === 1.0.1`
   (via IPC and/or the marker file). This is the proof the new code actually runs.

**U3 — integrity + safety guards fire (negative tests)**
- Tampered bytes (wrong sha256) → `downloadAndApply` fails, hotUpdateDir not left in
  a half-applied state.
- Download URL off-origin → rejected before any write.
- Zip containing a `../` entry → `verifyAllFilesWithin` throws (zip-slip blocked).
- Crash failsafe: a hot main.js that throws on import → `launcher.cts` deletes the
  hot dir and falls back to bundled (`launcher.cts:96-106`).

Splitting U1 (disk state) from U2 (fresh-launch behavior) deliberately avoids
fighting Electron's relaunch-in-place inside one Playwright context.

### Tier 3 — Full SIGNED E2E (later, own fleet)

Only the parts that genuinely need secrets/hardware live here — the unsigned
`publish` build logic is already covered in Tier 2 (P2). Tier 3 adds: real
**codesign + notarization** (Mac) and Authenticode signing (Windows), install on a
clean VM, and a real electron-updater self-update from the uploaded feed. Needs
signing certs (secrets) + notarization → staging/nightly only, paid for by the
build tier. Out of scope until that tier exists.

## CI wiring

```
matrix: [macos-latest, windows-latest]
steps:
  - tier 1 (also run standalone on ubuntu-latest for speed)
  - build the package (tsup) + build the fixture app
  - start fake backend
  - run Tier 2 Playwright-Electron suite
```

Headless note: Playwright-Electron runs on hosted runners without a display on
mac/windows; no xvfb needed (that is a Linux concern, and the Electron E2E does not
target Linux here).

## Definition of done

- Tier 1 green on every PR.
- Tier 2 green on both `macos-latest` and `windows-latest` on every PR.
- P1/U1/U2/U3 all implemented and passing.
- The `.map` platform discrepancy is covered by an explicit assertion.

## Open decision for the requester

Backend fidelity for Tier 2: in-memory mock (recommended — hermetic, every PR) vs
`supabase start` (real stack, slower, nightly). Spec is written for the mock; switch
only if a TUS/storage edge case proves the mock too lossy.
