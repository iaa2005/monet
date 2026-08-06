/**
 * The folder this bundle sits in, in every format it gets bundled into.
 *
 * The app's main bundle is ESM, where `__dirname` is simply not defined —
 * touching it is a ReferenceError, not undefined, so a fallback like
 * `__dirname ?? x` throws too. The Electron probes bundle the same modules
 * separately, and Electron's own module loader is CommonJS. Two formats, two
 * different names for one thing.
 *
 * This shipped as a bug once: the rasteriser used a bare `__dirname`, the
 * probe's CommonJS bundle had one, and the app threw on the first scan.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";

function resolveModuleDir(): string {
  // ESM: Node 20.11+ has import.meta.dirname; older ones have the URL. In a
  // CommonJS bundle esbuild replaces `import.meta` with an empty object, so
  // both reads are undefined rather than an error.
  const meta = import.meta as unknown as { dirname?: string; url?: string };
  if (typeof meta?.dirname === "string") return meta.dirname;
  if (typeof meta?.url === "string") return dirname(fileURLToPath(meta.url));
  // CommonJS.
  if (typeof __dirname !== "undefined") return __dirname;
  return process.cwd();
}

export const moduleDir = resolveModuleDir();
