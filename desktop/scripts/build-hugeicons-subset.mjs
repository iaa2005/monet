/**
 * Freeze the icons the app actually uses into a JSON file it ships with.
 *
 * @iconify/react asks api.iconify.design for any icon it does not already
 * hold. In a packaged Electron app that request goes out from a file://
 * origin, and a user offline (or behind a proxy that says no) gets a window
 * full of nothing — icons are the one thing that must never depend on the
 * network. So the names used in hg.tsx are read straight out of it, the
 * bodies are copied from the installed @iconify-json/hugeicons, and the
 * result is registered at import time.
 *
 * Full set: 5091 icons, ~1.5 MB of JSON. The subset is what a couple of
 * hundred cost instead.
 *
 *   node scripts/build-hugeicons-subset.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const collection = require("@iconify-json/hugeicons/icons.json");

const SOURCE = join("src", "renderer", "components", "icons", "hg.tsx");
const OUT = join("src", "renderer", "components", "icons", "hugeicons-subset.json");

export function namesUsed(source = readFileSync(SOURCE, "utf-8")) {
  return [...new Set([...source.matchAll(/hg\("([a-z0-9-]+)"\)/g)].map((m) => m[1]))].sort();
}

const names = namesUsed();
const missing = names.filter((n) => !collection.icons[n]);
if (missing.length) {
  console.error(`hugeicons has no such icon: ${missing.join(", ")}`);
  process.exit(1);
}

const icons = {};
for (const name of names) icons[name] = collection.icons[name];

const subset = {
  prefix: collection.prefix,
  icons,
  width: collection.width ?? 24,
  height: collection.height ?? 24,
};
// Aliases are not carried: hg.tsx names real icons only, and the probe keeps
// it that way.
writeFileSync(OUT, `${JSON.stringify(subset, null, 0)}\n`, "utf-8");
console.log(
  `${names.length} icons -> ${OUT} (${(JSON.stringify(subset).length / 1024).toFixed(0)} KB)`,
);
