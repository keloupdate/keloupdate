#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import { join } from 'path'
import { createInterface } from 'readline'
import * as tus from 'tus-js-client'
import { bumpVersion, getBumpType, isSafeDirName } from './internal'

const args = process.argv.slice(2)
const command = args[0]

// ─── Config loading ───

interface KeloConfig {
  supabaseUrl: string
  supabaseKey: string
  bucket: string
  include: string[]
  platform?: 'windows' | 'mac'
  buildCommand?: string
}

function loadConfig(): KeloConfig {
  const configPath = join(process.cwd(), 'kelo.config.json')
  if (!existsSync(configPath)) {
    console.error('ERROR: kelo.config.json not found. Run `kelo init` first.')
    process.exit(1)
  }

  let raw: any
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    console.error('ERROR: kelo.config.json contains invalid JSON.')
    process.exit(1)
  }

  raw.supabaseKey = process.env.KELO_SUPABASE_KEY || raw.supabaseKey
  if (!raw.supabaseKey || typeof raw.supabaseKey !== 'string') {
    console.error('ERROR: No Supabase key. Set KELO_SUPABASE_KEY env var.')
    process.exit(1)
  }
  if (!raw.supabaseUrl || typeof raw.supabaseUrl !== 'string') {
    console.error('ERROR: Missing supabaseUrl in kelo.config.json.')
    process.exit(1)
  }
  if (!Array.isArray(raw.include) || raw.include.length === 0) {
    console.error('ERROR: "include" must be a non-empty array in kelo.config.json.')
    process.exit(1)
  }
  for (const dir of raw.include) {
    if (typeof dir !== 'string' || !isSafeDirName(dir)) {
      console.error(`ERROR: Invalid include directory "${dir}". Only alphanumeric, dot, dash, and underscore are allowed.`)
      process.exit(1)
    }
  }
  if (!raw.bucket || typeof raw.bucket !== 'string') {
    raw.bucket = 'prod'
  }

  return raw
}

// ─── Helpers ───

function getPlatform(): 'windows' | 'mac' {
  if (args.includes('--windows') || args.includes('-w')) return 'windows'
  if (args.includes('--mac') || args.includes('-m')) return 'mac'
  return process.platform === 'win32' ? 'windows' : 'mac'
}

async function getLatestVersion(config: KeloConfig, platform: string): Promise<string | null> {
  const url = `${config.supabaseUrl}/rest/v1/kelo_releases?select=version&order=created_at.desc&limit=1&platform=eq.${encodeURIComponent(platform)}`
  const res = await fetch(url, {
    headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` },
  })
  if (!res.ok) return null
  const rows = await res.json()
  return rows.length > 0 ? rows[0].version : null
}

async function uploadToStorage(config: KeloConfig, storagePath: string, buffer: Buffer): Promise<string> {
  const totalMB = (buffer.length / 1024 / 1024).toFixed(1)
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(buffer, {
      endpoint: `${config.supabaseUrl}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000],
      chunkSize: 6 * 1024 * 1024,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      headers: {
        authorization: `Bearer ${config.supabaseKey}`,
        apikey: config.supabaseKey,
        'x-upsert': 'true',
      },
      metadata: {
        bucketName: config.bucket,
        objectName: storagePath,
        contentType: 'application/octet-stream',
      },
      onError(err) {
        reject(new Error(`Upload failed: ${err.message}`))
      },
      onProgress(bytesUploaded, bytesTotal) {
        const pct = ((bytesUploaded / bytesTotal) * 100).toFixed(0)
        const mb = (bytesUploaded / 1024 / 1024).toFixed(1)
        process.stdout.write(`\r   Uploading: ${mb}/${totalMB} MB (${pct}%)`)
      },
      onSuccess() {
        process.stdout.write(`\r   Uploading: ${totalMB}/${totalMB} MB (100%)\n`)
        resolve(`${config.supabaseUrl}/storage/v1/object/public/${config.bucket}/${storagePath}`)
      },
    })
    upload.findPreviousUploads().then((prev) => {
      if (prev.length) upload.resumeFromPreviousUpload(prev[0])
      upload.start()
    }).catch((err) => {
      console.warn('[kelo] Could not check for previous uploads:', err.message)
      upload.start()
    })
  })
}

async function insertRelease(config: KeloConfig, version: string, downloadUrl: string, releaseType: string, platform: string, sha256: string) {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/kelo_releases`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ version, download_url: downloadUrl, release_type: releaseType, platform, sha256 }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Insert release failed (${res.status}): ${text}`)
  }
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// ─── Commands ───

async function init() {
  console.log('\n  kelo init — Setting up kelo\n')

  const supabaseUrl = await ask('  Supabase URL: ')
  const bucket = (await ask('  Storage bucket (default: prod): ')) || 'prod'
  const buildCommand = (await ask('  Build command (default: npx vite build): ')) || 'npx vite build'

  const config = {
    supabaseUrl,
    bucket,
    include: ['dist', 'dist-electron'],
    buildCommand,
  }

  writeFileSync(join(process.cwd(), 'kelo.config.json'), JSON.stringify(config, null, 2) + '\n')

  console.log('\n  Created kelo.config.json')
  console.log('  Set KELO_SUPABASE_KEY env var with your service role key.')
  console.log('  Add kelo.config.json to .gitignore if it will contain secrets.')
  console.log('\n  Create this table in your Supabase project:\n')
  console.log(`  CREATE TABLE kelo_releases (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    version TEXT NOT NULL,
    download_url TEXT NOT NULL,
    sha256 TEXT,
    release_type TEXT NOT NULL DEFAULT 'update',
    platform TEXT NOT NULL DEFAULT 'mac',
    created_at TIMESTAMPTZ DEFAULT now()
  );\n`)
  console.log('  Done! Run `kelo update` to ship your first hot update.\n')
}

async function update() {
  const config = loadConfig()
  const platform = config.platform || getPlatform()
  const startTime = Date.now()

  const latest = await getLatestVersion(config, platform)
  const version = latest ? bumpVersion(latest, getBumpType(args)) : '1.0.0'
  if (latest) console.log(`   Latest: ${latest} → ${version}`)

  console.log(`\n=> kelo update v${version} (${platform})\n`)

  console.log('[1] Building...')
  try {
    execSync(config.buildCommand || 'npx vite build', { stdio: 'inherit', cwd: process.cwd() })
  } catch {
    console.error('ERROR: Build failed.')
    process.exit(1)
  }

  console.log('[2] Zipping...')
  const hotDir = join(process.cwd(), '.kelo')
  if (!existsSync(hotDir)) mkdirSync(hotDir, { recursive: true })

  const zipName = `${version}-hot.zip`
  const zipPath = join(hotDir, zipName)
  const includes = config.include.map(d => `${d}/`).join(' ')

  try {
    if (process.platform === 'win32') {
      const dirs = config.include.map(d => join(process.cwd(), d)).join(',')
      execSync(`powershell -Command "Compress-Archive -Path @(${dirs.split(',').map(d => `'${d}'`).join(',')}) -DestinationPath '${zipPath}' -Force"`, { stdio: 'inherit' })
    } else {
      execSync(`cd "${process.cwd()}" && zip -r "${zipPath}" ${includes} -x "*.map"`, { stdio: 'inherit' })
    }
  } catch {
    console.error('ERROR: Zip failed.')
    process.exit(1)
  }

  const fileBuffer = readFileSync(zipPath)
  const sha256 = createHash('sha256').update(fileBuffer).digest('hex')
  const sizeMB = (fileBuffer.length / 1024 / 1024).toFixed(1)
  console.log(`   Bundle: ${sizeMB} MB`)
  console.log(`   SHA-256: ${sha256}`)

  console.log('[3] Uploading...')
  const storagePath = `updates/${platform}/${zipName}`
  const downloadUrl = await uploadToStorage(config, storagePath, fileBuffer)

  await insertRelease(config, version, downloadUrl, 'update', platform, sha256)

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n=== Done! v${version} shipped in ${elapsed}s ===\n`)
}

async function status() {
  const config = loadConfig()
  const platform = config.platform || getPlatform()
  const latest = await getLatestVersion(config, platform)
  console.log(`\n  Platform: ${platform}`)
  console.log(`  Latest:   ${latest || 'no releases yet'}`)
  console.log(`  Bucket:   ${config.bucket}`)
  console.log(`  URL:      ${config.supabaseUrl}\n`)
}

// ─── Router ───

async function main() {
  switch (command) {
    case 'init':
      await init()
      break
    case 'update':
      await update()
      break
    case 'status':
      await status()
      break
    case 'publish':
      console.log('kelo publish — not yet implemented (use electron-builder directly for now)')
      break
    default:
      console.log(`
  kelo — Hot updates for Electron apps

  Commands:
    kelo init        Set up kelo in the current project
    kelo update      Ship a hot update (~5 sec)
    kelo publish     Full installer build + upload
    kelo status      Show version info

  Flags:
    --windows, -w    Target Windows
    --mac, -m        Target Mac
    --feature        Bump minor version
    --breaking       Bump major version
`)
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`)
  process.exit(1)
})
