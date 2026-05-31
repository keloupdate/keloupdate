import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..', '..')
export const FIXTURE = path.join(REPO, 'test', 'fixtures', 'app')
export const CLI = path.join(REPO, 'dist', 'cli.js')

export const TARGET_PLATFORM: 'mac' | 'windows' = process.platform === 'win32' ? 'windows' : 'mac'

// Regenerate the fixture's content with a given marker, then package it unpacked
// (electron-builder --dir) for the current OS. Returns the packaged binary path.
export async function buildAndPackageFixture(marker: string): Promise<string> {
  await execFileAsync('node', ['build.cjs'], {
    cwd: FIXTURE,
    env: { ...process.env, KELO_TEST_MARKER: marker },
  })
  const flag = process.platform === 'darwin' ? '--mac' : process.platform === 'win32' ? '--win' : '--linux'
  await execFileAsync('npx', ['electron-builder', '--dir', flag], {
    cwd: FIXTURE,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    maxBuffer: 64 * 1024 * 1024,
  })
  return findPackagedBinary()
}

export function findPackagedBinary(): string {
  const rel = path.join(FIXTURE, 'release')
  for (const dir of fs.readdirSync(rel)) {
    const base = path.join(rel, dir)
    if (!fs.statSync(base).isDirectory()) continue
    if (process.platform === 'darwin' && dir.startsWith('mac')) {
      const appName = fs.readdirSync(base).find((f) => f.endsWith('.app'))
      if (appName) return path.join(base, appName, 'Contents', 'MacOS', appName.replace(/\.app$/, ''))
    }
    if (process.platform === 'win32' && dir.includes('win')) {
      const exe = fs.readdirSync(base).find((f) => f.endsWith('.exe'))
      if (exe) return path.join(base, exe)
    }
    if (process.platform === 'linux' && dir.includes('linux')) {
      const bin = fs.readdirSync(base).find((n) => !path.extname(n) && fs.statSync(path.join(base, n)).isFile())
      if (bin) return path.join(base, bin)
    }
  }
  throw new Error(`packaged binary not found under ${rel}`)
}

// Run the built kelo CLI inside the fixture dir against the fake backend.
export async function runKeloCli(args: string[], origin: string, marker: string): Promise<void> {
  await execFileAsync('node', [CLI, ...args], {
    cwd: FIXTURE,
    env: { ...process.env, KELO_SUPABASE_KEY: 'test-key', KELO_TEST_MARKER: marker },
    maxBuffer: 64 * 1024 * 1024,
  })
}

// Write the fixture's kelo.config.json pointing at the fake backend.
export function writeFixtureConfig(origin: string, platform: 'mac' | 'windows'): void {
  fs.writeFileSync(
    path.join(FIXTURE, 'kelo.config.json'),
    JSON.stringify(
      { supabaseUrl: origin, bucket: 'prod', include: ['dist', 'dist-electron'], buildCommand: 'node build.cjs', platform },
      null,
      2
    )
  )
}
