// P1 — `kelo update` produces a valid, verifiable bundle (no Electron needed).
// Drives the real built CLI against the in-memory fake backend and asserts the
// uploaded bytes hash to the sha256 recorded on the release row.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

const execFileAsync = promisify(execFile)
import { fileURLToPath } from 'node:url'
import { startFakeBackend } from './fake-backend.ts'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = path.join(REPO, 'dist', 'cli.js')

// The fixture's "build command": emit the two include dirs with a stamped marker.
const BUILD_CJS = `
const fs = require('fs'); const path = require('path')
const marker = process.env.KELO_TEST_MARKER || 'base'
fs.mkdirSync('dist', { recursive: true })
fs.mkdirSync('dist-electron', { recursive: true })
fs.writeFileSync(path.join('dist', 'index.html'), '<!doctype html><title>fixture</title>')
fs.writeFileSync(path.join('dist-electron', 'main.js'), 'globalThis.__KELO_MARKER__ = ' + JSON.stringify(marker) + '\\n')
`

function setupFixture(origin: string, platform: 'mac' | 'windows'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelo-fixture-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2))
  fs.writeFileSync(path.join(dir, 'build.cjs'), BUILD_CJS)
  fs.writeFileSync(
    path.join(dir, 'kelo.config.json'),
    JSON.stringify(
      { supabaseUrl: origin, bucket: 'prod', include: ['dist', 'dist-electron'], buildCommand: 'node build.cjs', platform },
      null,
      2
    )
  )
  return dir
}

test('kelo update builds, uploads, and records a bundle whose bytes match the release sha256', async () => {
  const backend = await startFakeBackend()
  const platform: 'mac' | 'windows' = process.platform === 'win32' ? 'windows' : 'mac'
  const dir = setupFixture(backend.origin, platform)

  try {
    // Seed a 1.0.0 release so the bump produces 1.0.1 (> the fixture's bundled 1.0.0).
    backend.seedRelease({ version: '1.0.0', download_url: `${backend.origin}/seed`, platform })

    try {
      await execFileAsync('node', [CLI, 'update', platform === 'windows' ? '--windows' : '--mac'], {
        cwd: dir,
        env: { ...process.env, KELO_SUPABASE_KEY: 'test-key', KELO_TEST_MARKER: 'v2' },
        timeout: 30_000,
      })
    } catch (e: any) {
      throw new Error(`kelo update failed: ${e.message}\nSTDOUT:\n${e.stdout}\nSTDERR:\n${e.stderr}`)
    }

    // A new release row was inserted for the bumped version.
    const rows = backend.releases().filter((r) => r.release_type === 'update' && r.version === '1.0.1')
    assert.equal(rows.length, 1, 'exactly one 1.0.1 update release should be inserted')
    const row = rows[0]
    assert.equal(row.platform, platform)
    assert.match(row.sha256 || '', /^[0-9a-f]{64}$/, 'release row carries a sha256')

    // The stored object's bytes hash to that same sha256 (integrity end-to-end).
    const objectName = `updates/${platform}/1.0.1-hot.zip`
    const bytes = backend.storedObject(objectName)
    assert.ok(bytes && bytes.length > 0, `stored object ${objectName} exists and is non-empty`)
    const actual = createHash('sha256').update(bytes!).digest('hex')
    assert.equal(actual, row.sha256, 'uploaded bytes match the recorded sha256')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    await backend.close()
  }
})
