import { test, expect, _electron } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { startFakeBackend } from './fake-backend.ts'
import {
  buildAndPackageFixture,
  runKeloCli,
  writeFixtureConfig,
  TARGET_PLATFORM,
} from './fixture-helpers.ts'

let packagedBinary: string

test.beforeAll(async () => {
  // Package the "installed" app at v1.0.0 with build marker 'v1'.
  packagedBinary = await buildAndPackageFixture('v1')
})

function launch(binary: string, userData: string, origin: string) {
  return _electron.launch({
    executablePath: binary,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env, KELO_TEST_BACKEND: origin, KELO_TEST_PLATFORM: TARGET_PLATFORM },
  })
}

// Smoke: packaged fixture launches and the kelo IPC bridge answers.
test('packaged fixture launches and reports its bundled version', async () => {
  const backend = await startFakeBackend()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kelo-ud-'))
  const app = await launch(packagedBinary, userData, backend.origin)
  try {
    const win = await app.firstWindow()
    const result = await win.evaluate(() => (window as any).electronAPI.kelo.invoke('kelo:get-version'))
    expect(result.version).toBe('1.0.0')
  } finally {
    await app.close()
    await backend.close()
    fs.rmSync(userData, { recursive: true, force: true })
  }
})

// The real one: update ${platform} — app checks, downloads, verifies, applies,
// and runs the NEW code after relaunch.
test(`update ${TARGET_PLATFORM}: download, verify, apply, and run new code after relaunch`, async () => {
  const backend = await startFakeBackend()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kelo-ud-'))
  try {
    writeFixtureConfig(backend.origin, TARGET_PLATFORM)
    // Seed a 1.0.0 release so `kelo update` bumps to 1.0.1 (> the bundled 1.0.0).
    backend.seedRelease({ version: '1.0.0', download_url: `${backend.origin}/seed`, platform: TARGET_PLATFORM })
    // Produce + upload the 1.0.1 hot bundle, built with a DIFFERENT marker ('v2').
    await runKeloCli(['update', TARGET_PLATFORM === 'windows' ? '--windows' : '--mac'], backend.origin, 'v2')

    // ── Launch 1: bundled v1 running. Drive check + download (U1). ──
    const app1 = await launch(packagedBinary, userData, backend.origin)
    const win1 = await app1.firstWindow()
    const check = await win1.evaluate(() => (window as any).electronAPI.kelo.invoke('kelo:check'))
    expect(check, 'an update should be reported').toBeTruthy()
    expect(check.version).toBe('1.0.1')
    const dl = await win1.evaluate(() => (window as any).electronAPI.kelo.invoke('kelo:download'))
    expect(dl.success, `download/apply should succeed: ${dl.error ?? ''}`).toBe(true)

    // bundled code (marker v1) is what ran this launch
    const boot1 = JSON.parse(fs.readFileSync(path.join(userData, 'boot.json'), 'utf-8'))
    expect(boot1.marker).toBe('v1')
    // the hot update landed on disk, verified + extracted
    expect(fs.readFileSync(path.join(userData, 'kelo', 'version.txt'), 'utf-8').trim()).toBe('1.0.1')
    expect(fs.existsSync(path.join(userData, 'kelo', 'dist-electron', 'main.js'))).toBe(true)
    await app1.close()

    // ── Launch 2: launcher should load the HOT main (marker v2) at v1.0.1 (U2). ──
    const app2 = await launch(packagedBinary, userData, backend.origin)
    const win2 = await app2.firstWindow()
    const ver = await win2.evaluate(() => (window as any).electronAPI.kelo.invoke('kelo:get-version'))
    expect(ver.version, 'relaunch should report the hot version').toBe('1.0.1')
    const boot2 = JSON.parse(fs.readFileSync(path.join(userData, 'boot.json'), 'utf-8'))
    expect(boot2.marker, 'the NEW code (marker v2) must be what ran').toBe('v2')
    await app2.close()
  } finally {
    await backend.close()
    fs.rmSync(userData, { recursive: true, force: true })
  }
})
