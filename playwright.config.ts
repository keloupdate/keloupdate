import { defineConfig } from '@playwright/test'

// E2E suite drives the packaged fixture Electron app. One worker, no parallelism:
// packaging is shared and the tests share a backend/app lifecycle.
export default defineConfig({
  testDir: './test/e2e',
  testMatch: '*.spec.ts',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  // electron-builder downloads NSIS/winCodeSign from GitHub releases, which can
  // hiccup transiently on CI. Retry failed E2E runs there (not locally).
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
})
