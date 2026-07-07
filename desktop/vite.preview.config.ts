/**
 * Browser-only preview of the renderer (no Electron) for visual QA.
 * The real app still runs through electron-vite.
 */
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r("./src/renderer"),
  resolve: { alias: { "@": r("./src/renderer") } },
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [react()],
  server: { port: 5199, strictPort: true },
});
