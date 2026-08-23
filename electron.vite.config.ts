import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/main/index.ts'), external: ['electron', 'sharp', 'tesseract.js', '@tesseract.js-data/eng'] } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/preload/index.ts'), external: ['electron'], output: { format: 'cjs', entryFileNames: 'index.cjs' } } }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@': resolve('src') } },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
