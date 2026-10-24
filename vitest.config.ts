import { defineConfig } from 'vitest/config'
import pkg from './apps/boss-agent/package.json'

export default defineConfig({
  define: { __AAH_BOSS_VERSION__: JSON.stringify(pkg.version) },
  test: {
    environment: 'jsdom',
    include: ['packages/boss-core/src/**/*.test.ts', 'legacy/userscript/src/**/*.test.ts'],
  },
})
