import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import pkg from './package.json'
import { resolve } from 'node:path'

const app = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  define: { __AAH_BOSS_VERSION__: JSON.stringify(pkg.version) },
  root: app,
  build: {
    outDir: resolve(app, '../../dist/boss-agent'),
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(app, 'src/content.ts'),
      name: 'GuguBossAgentContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
})
