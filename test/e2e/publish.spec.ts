import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { startFakeBackend } from './fake-backend.ts'
import { FIXTURE, runKeloCli, writeFixtureConfig, TARGET_PLATFORM } from './fixture-helpers.ts'

// publish ${platform} — `kelo publish` builds a real (unsigned) installer with
// electron-builder, produces the electron-updater feed, uploads both, records a
// publish release, and leaves package.json clean.
test(`publish ${TARGET_PLATFORM}: builds installer + updater feed, uploads them, restores package.json`, async () => {
  test.setTimeout(300_000) // electron-builder packaging + artifact upload is heavy
  const backend = await startFakeBackend()
  try {
    writeFixtureConfig(backend.origin, TARGET_PLATFORM)
    // isolate from any prior build output
    fs.rmSync(path.join(FIXTURE, 'release'), { recursive: true, force: true })
    fs.rmSync(path.join(FIXTURE, 'dist'), { recursive: true, force: true })

    await runKeloCli(
      ['publish', TARGET_PLATFORM === 'windows' ? '--windows' : '--mac', '--version', '2.0.0'],
      backend.origin,
      'pub'
    )

    // a publish release row was recorded
    const rows = backend.releases().filter((r) => r.release_type === 'publish' && r.version === '2.0.0')
    expect(rows.length, 'one publish release row inserted').toBe(1)
    const row = rows[0]
    expect(row.platform).toBe(TARGET_PLATFORM)
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)

    // the installer + the electron-updater feed were uploaded
    const keys = backend.objectKeys()
    const feedRe = TARGET_PLATFORM === 'windows' ? /latest\.yml$/ : /latest-mac\.yml$/
    const installerRe = TARGET_PLATFORM === 'windows' ? /Setup.*\.exe$/ : /-mac\.zip$/
    expect(keys.some((k) => feedRe.test(k)), `updater feed uploaded (keys: ${keys.join(', ')})`).toBe(true)
    expect(keys.some((k) => installerRe.test(k)), `installer uploaded (keys: ${keys.join(', ')})`).toBe(true)

    // the recorded download_url's bytes hash to the row's sha256 (integrity)
    const installerKey = keys.find((k) => installerRe.test(k))!
    const bytes = backend.storedObject(installerKey)!
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256)

    // package.json was restored — working tree left clean
    const pkg = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf-8'))
    expect(pkg.version, 'package.json version restored').toBe('1.0.0')
  } finally {
    await backend.close()
  }
})
