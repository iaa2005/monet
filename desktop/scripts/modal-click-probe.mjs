/**
 * Bundles modal-click-probe.tsx for the browser and runs it inside a real
 * Electron renderer, so React click handlers are exercised for real.
 *
 * A DOM is the whole point: this checks that a click inside a nested modal
 * does not reach the parent modal's backdrop, which no amount of reading the
 * JSX can establish.
 */
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const OUT = 'out-probe'

await build({
  configFile: false,
  logLevel: 'warn',
  resolve: { alias: [{ find: '@', replacement: resolve('src/renderer') }] },
  define: { 'process.env.NODE_ENV': '"development"' },
  build: {
    outDir: OUT,
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: resolve('scripts/modal-click-probe.tsx'),
      formats: ['iife'],
      name: 'ModalProbe',
      fileName: () => 'modal-click-probe.js',
    },
  },
})

mkdirSync(OUT, { recursive: true })
writeFileSync(
  resolve(OUT, 'modal-click-probe.html'),
  '<!doctype html><meta charset="utf-8"><body></body><script src="./modal-click-probe.js"></script>',
)

// A tiny Electron main that loads the page and relays console output.
const mainPath = resolve(OUT, 'modal-click-main.cjs')
writeFileSync(
  mainPath,
  `const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  win.webContents.on('console-message', (_e, _l, message) => console.log(message));
  await win.loadFile(${JSON.stringify(resolve(OUT, 'modal-click-probe.html'))});
  const started = Date.now();
  const poll = setInterval(async () => {
    const done = await win.webContents.executeJavaScript('window.__done');
    if (typeof done === 'number') { clearInterval(poll); app.exit(done > 0 ? 1 : 0); }
    else if (Date.now() - started > 30000) { clearInterval(poll); console.log('TIMED OUT'); app.exit(1); }
  }, 200);
});`,
)

const r = spawnSync(require('electron'), [mainPath], { stdio: 'inherit' })
process.exit(r.status ?? 1)
