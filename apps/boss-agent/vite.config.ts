import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import pkg from './package.json'
import { resolve } from 'node:path'

const app = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  define: { __AAH_BOSS_VERSION__: JSON.stringify(pkg.version) },
  root: app,
  plugins: [vue()],
  build: {
    outDir: resolve(app, '../../dist/boss-agent'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(app, 'popup.html'),
        panel: resolve(app, 'panel.html'),
        background: resolve(app, 'src/background.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
