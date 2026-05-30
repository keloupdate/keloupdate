/**
 * Kelo Launcher — the one file that never gets hot-updated.
 *
 * Electron loads this as its entry point (CJS). It checks for a hot-updated
 * main.js in userData and loads that instead. If none exists or it crashes,
 * falls back to the bundled main.js.
 *
 * Usage: set "main": "node_modules/kelo/dist/launcher.cjs" in package.json
 * Or copy this file to your project and point "main" at it.
 */
const { app, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const hotUpdateDir = path.join(app.getPath('userData'), 'kelo')
const hotUpdateMain = path.join(hotUpdateDir, 'dist-electron', 'main.js')

// In dev mode, delete stale hot-update so local builds always take effect.
if (!app.isPackaged && fs.existsSync(hotUpdateDir)) {
  try {
    fs.rmSync(hotUpdateDir, { recursive: true, force: true })
  } catch (e: any) {
    console.warn('[kelo] Dev mode — could not delete stale hot-update:', e.message)
  }
}

// After a full publish (electron-updater), the .app bundle may have a newer version.
// Delete stale hot-update so the bundled code runs.
if (app.isPackaged && fs.existsSync(path.join(hotUpdateDir, 'version.txt'))) {
  try {
    const hotVersion = fs.readFileSync(path.join(hotUpdateDir, 'version.txt'), 'utf-8').trim()
    if (!/^\d+\.\d+\.\d+$/.test(hotVersion)) {
      console.warn('[kelo] Invalid hot-update version format, clearing')
      fs.rmSync(hotUpdateDir, { recursive: true, force: true })
    } else {
    const bundledPkgPath = path.join(__dirname, '..', 'package.json')
    const bundledPkg = JSON.parse(fs.readFileSync(bundledPkgPath, 'utf-8'))
    const hv = hotVersion.split('.').map(Number)
    const bv = bundledPkg.version.split('.').map(Number)
    let bundledIsNewer = false
    for (let i = 0; i < 3; i++) {
      if ((bv[i] || 0) > (hv[i] || 0)) { bundledIsNewer = true; break }
      if ((bv[i] || 0) < (hv[i] || 0)) { break }
    }
    if (bundledIsNewer) {
      console.log(`[kelo] Bundled v${bundledPkg.version} > hot v${hotVersion}, clearing stale hot-update`)
      fs.rmSync(hotUpdateDir, { recursive: true, force: true })
    }
    }
  } catch (e: any) {
    console.warn('[kelo] Error checking hot-update staleness:', e.message)
  }
}

// Determine which main.js to load
let mainPath: string
if (fs.existsSync(hotUpdateMain)) {
  console.log('[kelo] Loading hot-update main.js')
  mainPath = hotUpdateMain

  // Hot-update main.js needs node_modules from the installed app.
  // Create a symlink/junction so Node's module resolution finds them.
  const appNodeModules = app.isPackaged
    ? path.join(path.dirname(app.getAppPath()), 'app.asar.unpacked', 'node_modules')
    : path.join(__dirname, '..', 'node_modules')
  const hotNodeModules = path.join(hotUpdateDir, 'node_modules')

  // Remove stale symlink if it points to wrong location
  if (fs.existsSync(hotNodeModules)) {
    try {
      const stats = fs.lstatSync(hotNodeModules)
      if (stats.isSymbolicLink()) {
        const target = fs.readlinkSync(hotNodeModules)
        if (target.includes('app.asar') && !target.includes('app.asar.unpacked')) {
          fs.unlinkSync(hotNodeModules)
        }
      }
    } catch (e: any) {
      console.warn('[kelo] Error checking symlink:', e.message)
    }
  }

  if (fs.existsSync(appNodeModules) && !fs.existsSync(hotNodeModules)) {
    try {
      fs.symlinkSync(appNodeModules, hotNodeModules, 'junction')
    } catch (err: any) {
      console.error('[kelo] Failed to create node_modules symlink:', err.message)
    }
  }
} else {
  mainPath = path.join(__dirname, 'main.js')
}

// Load the chosen main.js with crash failsafe
import(pathToFileURL(mainPath).href).catch((err) => {
  const bundledMain = path.join(__dirname, 'main.js')
  if (mainPath !== bundledMain && fs.existsSync(hotUpdateDir)) {
    console.error('[kelo] Hot-update crashed, falling back to bundled:', err.message)
    try { fs.rmSync(hotUpdateDir, { recursive: true, force: true }) } catch (e: any) {
      console.warn('[kelo] Could not clean hot-update dir:', e.message)
    }
    import(pathToFileURL(bundledMain).href).catch((err2) => {
      dialog.showErrorBox('Update Error', `Failed to load app: ${err2.message}`)
      app.exit(1)
    })
  } else {
    dialog.showErrorBox('App Error', `Failed to load: ${err.message}`)
    app.exit(1)
  }
})
