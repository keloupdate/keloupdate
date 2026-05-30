import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: {
      cli: 'src/cli.ts',
      updater: 'src/updater.ts',
      react: 'src/react.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
  },
  {
    entry: { launcher: 'src/launcher.cts' },
    format: ['cjs'],
    clean: false,
  },
])
