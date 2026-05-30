import { app, ipcMain, BrowserWindow } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'
import {
  isValidVersion,
  compareVersions,
  verifyAllFilesWithin,
  isAllowedOrigin,
  verifySha256,
} from './internal'

export interface KeloConfig {
  supabaseUrl: string
  supabaseKey: string
  bucket?: string
  checkInterval?: number
  platform?: 'windows' | 'mac'
}

const HOT_DIR_NAME = 'kelo'

function getHotUpdateDir() {
  return path.join(app.getPath('userData'), HOT_DIR_NAME)
}

function getCurrentVersion(): string {
  const hotVersionFile = path.join(getHotUpdateDir(), 'version.txt')
  if (fs.existsSync(hotVersionFile)) {
    const v = fs.readFileSync(hotVersionFile, 'utf-8').trim()
    if (isValidVersion(v)) return v
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf-8'))
    if (isValidVersion(pkg.version)) return pkg.version
  } catch {}
  return '0.0.0'
}

function getPlatform(): 'windows' | 'mac' {
  return process.platform === 'win32' ? 'windows' : 'mac'
}

interface UpdateInfo {
  version: string
  url: string
  sha256: string | null
}

async function checkForUpdate(config: KeloConfig): Promise<UpdateInfo | null> {
  const platform = config.platform || getPlatform()
  const currentVersion = getCurrentVersion()

  const res = await fetch(
    `${config.supabaseUrl}/rest/v1/kelo_releases?select=version,download_url,sha256&platform=eq.${encodeURIComponent(platform)}&release_type=eq.update&order=created_at.desc&limit=1`,
    {
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
      },
    }
  )

  if (!res.ok) return null
  const rows = await res.json()
  if (!Array.isArray(rows) || rows.length === 0) return null

  const latest = rows[0]
  if (typeof latest.version !== 'string' || typeof latest.download_url !== 'string') return null
  if (!isValidVersion(latest.version)) return null
  if (compareVersions(latest.version, currentVersion) <= 0) return null

  return { version: latest.version, url: latest.download_url, sha256: latest.sha256 || null }
}

async function downloadAndApply(
  url: string,
  version: string,
  expectedHash: string | null,
  config: KeloConfig
): Promise<{ success: boolean; error?: string }> {
  if (!isValidVersion(version)) return { success: false, error: 'Invalid version format' }

  if (!isAllowedOrigin(url, config.supabaseUrl)) {
    return { success: false, error: 'Download URL does not match configured Supabase origin' }
  }

  const hotUpdateBase = getHotUpdateDir()

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)

    if (!response.ok) throw new Error(`Download failed: ${response.status}`)

    const totalBytes = parseInt(response.headers.get('content-length') || '0', 10)
    const win = BrowserWindow.getAllWindows()[0]
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let downloadedBytes = 0

    if (reader) {
      let lastProgress = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        downloadedBytes += value.length
        const now = Date.now()
        if (totalBytes > 0 && now - lastProgress > 100) {
          lastProgress = now
          win?.webContents?.send('kelo:progress', { downloaded: downloadedBytes, total: totalBytes })
        }
      }
    } else {
      const buf = await response.arrayBuffer()
      chunks.push(new Uint8Array(buf))
    }

    const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)))

    if (expectedHash && !verifySha256(buffer, expectedHash)) {
      throw new Error('Integrity check failed: sha256 mismatch')
    }

    if (fs.existsSync(hotUpdateBase)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.rmSync(hotUpdateBase, { recursive: true, force: true })
          break
        } catch (e) {
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000))
          else throw e
        }
      }
    }
    fs.mkdirSync(hotUpdateBase, { recursive: true })

    const zipPath = path.join(hotUpdateBase, 'update.zip')
    fs.writeFileSync(zipPath, buffer)

    if (process.platform === 'win32') {
      execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${hotUpdateBase}' -Force"`, { timeout: 30000 })
    } else {
      execSync(`unzip -o "${zipPath}" -d "${hotUpdateBase}"`, { timeout: 30000 })
    }

    verifyAllFilesWithin(hotUpdateBase)

    if (process.platform === 'darwin') {
      const distElectron = path.join(hotUpdateBase, 'dist-electron')
      if (fs.existsSync(distElectron)) {
        try {
          execSync(`find "${hotUpdateBase}" -type f -perm +0111 -exec xattr -d com.apple.quarantine {} \\; 2>/dev/null`)
        } catch (e: any) {
          console.warn('[kelo] xattr cleanup failed:', e.message)
        }
      }
    }

    fs.unlinkSync(zipPath)
    fs.writeFileSync(path.join(hotUpdateBase, 'version.txt'), version)

    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

export function createKeloUpdater(config: KeloConfig) {
  const checkInterval = config.checkInterval ?? 5 * 60 * 1000
  let pendingUpdate: UpdateInfo | null = null

  ipcMain.handle('kelo:get-version', () => {
    return { version: getCurrentVersion() }
  })

  ipcMain.handle('kelo:check', async () => {
    pendingUpdate = await checkForUpdate(config)
    return pendingUpdate ? { version: pendingUpdate.version } : null
  })

  ipcMain.handle('kelo:download', async () => {
    if (!pendingUpdate) return { success: false, error: 'No update available. Run check first.' }
    const { url, version, sha256 } = pendingUpdate
    return await downloadAndApply(url, version, sha256, config)
  })

  ipcMain.handle('kelo:apply', () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle('kelo:clear', () => {
    const dir = getHotUpdateDir()
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    return { success: true }
  })

  const check = async () => {
    try {
      const update = await checkForUpdate(config)
      if (update) {
        pendingUpdate = update
        const win = BrowserWindow.getAllWindows()[0]
        win?.webContents?.send('kelo:update-available', { version: update.version })
      }
    } catch (err: any) {
      console.warn('[kelo] Update check failed:', err.message)
    }
  }

  setTimeout(check, 5000)
  setInterval(check, checkInterval)

  return { check, getCurrentVersion }
}
