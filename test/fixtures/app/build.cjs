// Fixture "build command" (and one-time prep). Idempotent. Run by `kelo update`
// (config.buildCommand) and by the packaging step in the E2E tests.
//
//  - regenerates dist/ (renderer) + dist-electron/ (main, preload), stamped with
//    a marker so we can prove which code actually ran;
//  - copies the real kelo launcher in as the app entry;
//  - vendors the built kelo package into node_modules/kelo so packaging + the
//    runtime `import('kelo')` resolve it the same way a real install would.

const fs = require('fs')
const path = require('path')

const APP = __dirname
const REPO = path.resolve(APP, '..', '..', '..')
const marker = process.env.KELO_TEST_MARKER || 'v1'

fs.mkdirSync(path.join(APP, 'dist'), { recursive: true })
fs.mkdirSync(path.join(APP, 'dist-electron'), { recursive: true })

// ── renderer ──
fs.writeFileSync(
  path.join(APP, 'dist', 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>kelo fixture</title><body>kelo fixture</body>'
)

// ── main process (CJS; loaded by the launcher via dynamic import) ──
const mainSrc = `const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const MARKER = ${JSON.stringify(marker)}
app.whenReady().then(async () => {
  // record which code actually ran, for the relaunch assertion
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'boot.json'), JSON.stringify({ marker: MARKER })) } catch (e) {}
  ipcMain.handle('fixture:marker', () => MARKER)
  try {
    const kelo = await import('kelo')
    kelo.createKeloUpdater({
      supabaseUrl: process.env.KELO_TEST_BACKEND || 'http://127.0.0.1:1',
      supabaseKey: 'test-key',
      bucket: 'prod',
      platform: process.env.KELO_TEST_PLATFORM || (process.platform === 'win32' ? 'windows' : 'mac'),
      checkInterval: 24 * 3600 * 1000,
    })
  } catch (e) {
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'kelo-error.txt'), String((e && e.stack) || e)) } catch (e2) {}
  }
  const win = new BrowserWindow({
    width: 420, height: 300, show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
})
app.on('window-all-closed', () => app.quit())
`
fs.writeFileSync(path.join(APP, 'dist-electron', 'main.js'), mainSrc)

// ── preload (exposes the kelo IPC bridge under window.electronAPI.kelo) ──
const preloadSrc = `const { contextBridge, ipcRenderer } = require('electron')
const bridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, handler) => {
    const l = (_e, ...a) => handler(...a)
    ipcRenderer.on(channel, l)
    return () => ipcRenderer.removeListener(channel, l)
  },
}
contextBridge.exposeInMainWorld('electronAPI', { ...bridge, kelo: bridge })
`
fs.writeFileSync(path.join(APP, 'dist-electron', 'preload.js'), preloadSrc)

// ── copy the real kelo launcher in as the entry point ──
fs.copyFileSync(path.join(REPO, 'dist', 'launcher.cjs'), path.join(APP, 'dist-electron', 'launcher.cjs'))

// ── vendor the built kelo package into node_modules/kelo ──
const keloPkg = path.join(APP, 'node_modules', 'kelo')
fs.rmSync(keloPkg, { recursive: true, force: true })
fs.mkdirSync(keloPkg, { recursive: true })
fs.cpSync(path.join(REPO, 'dist'), path.join(keloPkg, 'dist'), { recursive: true })
fs.copyFileSync(path.join(REPO, 'package.json'), path.join(keloPkg, 'package.json'))

console.log('[fixture build.cjs] generated dist + dist-electron, marker=' + marker)
