// Postinstall: applies shims/patches to node_modules for missing packages
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const patches = join(root, "patches");

// Shim packages — copy into node_modules
const shimDirs = ["@ant", "@anthropic-ai", "@growthbook", "color-diff-napi"];

for (const dir of shimDirs) {
  const src = join(patches, dir);
  const dest = join(root, "node_modules", dir);
  if (existsSync(src)) {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
    console.log("[patches] applied:", dir);
  }
}

// @opentelemetry/resources patch — add resourceFromAttributes export
const otelIndex = join(
  root,
  "node_modules",
  "@opentelemetry",
  "resources",
  "build",
  "src",
  "index.js",
);
const otelPatch = join(
  patches,
  "@opentelemetry",
  "resources",
  "build",
  "src",
  "index.js",
);
if (existsSync(otelPatch) && existsSync(otelIndex)) {
  const patched = readFileSync(otelPatch, "utf8");
  writeFileSync(otelIndex, patched);
  console.log(
    "[patches] applied: @opentelemetry/resources (resourceFromAttributes)",
  );
}

console.log("[patches] done");

// Create src/ symlink for path aliases (src/* → ./*)
const srcLink = join(root, "src");
if (!existsSync(srcLink)) {
  try {
    const type = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(root, srcLink, type);
    console.log("[patches] created src symlink");
  } catch (e) {
    console.log(
      "[patches] src symlink skipped (may need admin on Windows):",
      e.message,
    );
  }
}
console.log("[patches] all done");
