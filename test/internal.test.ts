import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  isValidVersion,
  compareVersions,
  bumpVersion,
  getBumpType,
  isSafeDirName,
  isAllowedOrigin,
  verifySha256,
  verifyAllFilesWithin,
} from '../src/internal.ts'

// ─── isValidVersion ───

test('isValidVersion accepts a three-part numeric version', () => {
  assert.equal(isValidVersion('1.2.3'), true)
  assert.equal(isValidVersion('0.0.0'), true)
  assert.equal(isValidVersion('10.20.30'), true)
})

test('isValidVersion rejects non semver-triple strings', () => {
  assert.equal(isValidVersion('1.2'), false)
  assert.equal(isValidVersion('1.2.3.4'), false)
  assert.equal(isValidVersion('1.2.3-beta'), false)
  assert.equal(isValidVersion('v1.2.3'), false)
  assert.equal(isValidVersion('abc'), false)
  assert.equal(isValidVersion(''), false)
})

// ─── compareVersions ───

test('compareVersions returns 1 when the first version is greater', () => {
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1)
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
  assert.equal(compareVersions('1.1.0', '1.0.9'), 1)
})

test('compareVersions returns -1 when the first version is smaller', () => {
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
  assert.equal(compareVersions('1.9.9', '2.0.0'), -1)
})

test('compareVersions returns 0 for equal versions', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
})

test('compareVersions treats missing trailing parts as zero', () => {
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
})

// ─── bumpVersion ───

test('bumpVersion increments the patch by default', () => {
  assert.equal(bumpVersion('1.2.3'), '1.2.4')
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4')
})

test('bumpVersion increments the minor and resets the patch', () => {
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0')
})

test('bumpVersion increments the major and resets minor and patch', () => {
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0')
})

test('bumpVersion throws on a malformed version', () => {
  assert.throws(() => bumpVersion('1.2'), /Invalid version/)
  assert.throws(() => bumpVersion('abc'), /Invalid version/)
})

// ─── getBumpType ───

test('getBumpType maps --breaking to major', () => {
  assert.equal(getBumpType(['push', '--breaking']), 'major')
})

test('getBumpType maps --feature to minor', () => {
  assert.equal(getBumpType(['push', '--feature']), 'minor')
})

test('getBumpType defaults to patch with no bump flag', () => {
  assert.equal(getBumpType(['push']), 'patch')
  assert.equal(getBumpType([]), 'patch')
})

// ─── isSafeDirName (include-dir validation) ───

test('isSafeDirName accepts plain directory names', () => {
  assert.equal(isSafeDirName('dist'), true)
  assert.equal(isSafeDirName('dist-electron'), true)
  assert.equal(isSafeDirName('build_2'), true)
  assert.equal(isSafeDirName('a.b'), true)
})

test('isSafeDirName rejects traversal and separators', () => {
  assert.equal(isSafeDirName('..'), false)
  assert.equal(isSafeDirName('../etc'), false)
  assert.equal(isSafeDirName('a/b'), false)
  assert.equal(isSafeDirName('a\\b'), false)
  assert.equal(isSafeDirName('foo bar'), false)
  assert.equal(isSafeDirName(''), false)
  assert.equal(isSafeDirName('$(rm -rf)'), false)
})

// ─── isAllowedOrigin (download URL origin check) ───

test('isAllowedOrigin accepts a URL under the configured origin', () => {
  assert.equal(
    isAllowedOrigin('https://proj.example.co/storage/v1/object/public/prod/x.zip', 'https://proj.example.co'),
    true
  )
})

test('isAllowedOrigin rejects an off-origin URL', () => {
  assert.equal(isAllowedOrigin('https://evil.example/x.zip', 'https://proj.example.co'), false)
})

test('isAllowedOrigin rejects a prefix-spoofing host', () => {
  // attacker host that merely starts with the origin string but is a different host
  assert.equal(isAllowedOrigin('https://proj.example.co.evil.test/x.zip', 'https://proj.example.co'), false)
})

test('isAllowedOrigin rejects the bare origin with no trailing path', () => {
  assert.equal(isAllowedOrigin('https://proj.example.co', 'https://proj.example.co'), false)
})

// ─── verifySha256 ───

test('verifySha256 returns true when the digest matches', () => {
  // sha256("abc")
  const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  assert.equal(verifySha256(Buffer.from('abc'), expected), true)
})

test('verifySha256 returns false on a mismatched digest', () => {
  const wrong = '0'.repeat(64)
  assert.equal(verifySha256(Buffer.from('abc'), wrong), false)
})

test('verifySha256 returns true for the empty buffer against its known digest', () => {
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  assert.equal(verifySha256(Buffer.alloc(0), empty), true)
})

// ─── verifyAllFilesWithin (zip-slip guard) ───

test('verifyAllFilesWithin passes for a tree fully inside the directory', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kelo-zipslip-ok-'))
  try {
    fs.mkdirSync(path.join(base, 'sub'))
    fs.writeFileSync(path.join(base, 'sub', 'file.txt'), 'hi')
    assert.doesNotThrow(() => verifyAllFilesWithin(base))
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('verifyAllFilesWithin throws when a symlink escapes the directory', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kelo-zipslip-bad-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kelo-outside-'))
  try {
    const secret = path.join(outside, 'secret.txt')
    fs.writeFileSync(secret, 'top secret')
    fs.symlinkSync(secret, path.join(base, 'escape'))
    assert.throws(() => verifyAllFilesWithin(base), /Zip slip/)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})
