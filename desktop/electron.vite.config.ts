import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        'bun:bundle': resolve('src/main/shims/bun-bundle.ts'),
        'src/bootstrap/state.js': resolve('src/main/shims/bootstrap-state.ts'),
        'src/utils/crypto.js': resolve('src/main/shims/crypto.ts'),
        '@vendor': resolve('src/vendor/leaked'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
        '@vendor': resolve('src/vendor/leaked'),
        'bun:bundle': resolve('src/main/shims/bun-bundle.ts'),
        'src/bootstrap/state.js': resolve('src/main/shims/bootstrap-state.ts'),
        'src/utils/crypto.js': resolve('src/main/shims/crypto.ts'),
      },
    },
    plugins: [react()],
    css: {
      postcss: './postcss.config.js',
    },
  },
})
