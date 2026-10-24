import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import pkg from './package.json'

export default defineConfig({
  define: { __AAH_BOSS_VERSION__: JSON.stringify(pkg.version) },
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
})
