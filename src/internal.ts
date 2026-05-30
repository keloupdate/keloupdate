// Pure, Electron-free helpers shared by the CLI and the client updater.
// Kept import-light (only node:fs / node:path / node:crypto) so the
// security-critical logic can be unit-tested without booting Electron.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

export type BumpType = 'patch' | 'minor' | 'major'

const VERSION_RE = /^\d+\.\d+\.\d+$/
export const SAFE_DIR_NAME = /^[a-zA-Z0-9._-]+$/

export function isValidVersion(v: string): boolean {
  return VERSION_RE.test(v)
}

export function compareVersions(a: string, b: string): number {
  const av = a.split('.').map(Number)
  const bv = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((av[i] || 0) > (bv[i] || 0)) return 1
    if ((av[i] || 0) < (bv[i] || 0)) return -1
  }
  return 0
}

export function bumpVersion(version: string, type: BumpType = 'patch'): string {
  const parts = version.split('.').map(Number)
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid version string: "${version}"`)
  }
  const [major, minor, patch] = parts
  if (type === 'major') return `${major + 1}.0.0`
  if (type === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

export function getBumpType(args: string[]): BumpType {
  if (args.includes('--breaking')) return 'major'
  if (args.includes('--feature')) return 'minor'
  return 'patch'
}

export function isSafeDirName(name: string): boolean {
  // The charset already blocks separators; also reject the traversal tokens
  // "." and ".." that the charset would otherwise allow.
  return SAFE_DIR_NAME.test(name) && name !== '.' && name !== '..'
}

// A download URL is trusted only if it sits strictly *under* the configured
// origin. The trailing slash is required so a host that merely starts with the
// origin string (e.g. "<origin>.evil.test") cannot pass.
export function isAllowedOrigin(url: string, supabaseUrl: string): boolean {
  return url.startsWith(supabaseUrl + '/')
}

export function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export function verifySha256(buffer: Buffer, expectedHash: string): boolean {
  return sha256Hex(buffer) === expectedHash
}

// Zip-slip guard: every entry under `dir` must resolve (after following any
// symlinks) to a path inside `dir`. Throws on the first escaping entry.
export function verifyAllFilesWithin(dir: string): void {
  const realBase = fs.realpathSync(dir)
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fullPath = path.join(d, entry.name)
      const realPath = fs.realpathSync(fullPath)
      if (!realPath.startsWith(realBase + path.sep) && realPath !== realBase) {
        throw new Error(`Zip slip detected: ${entry.name} resolves outside target directory`)
      }
      if (entry.isDirectory()) walk(fullPath)
    }
  }
  walk(dir)
}
