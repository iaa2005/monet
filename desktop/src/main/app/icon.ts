/**
 * Where the app's own picture lives.
 *
 * Three places want it — the tray, the dev window (packaged builds get the
 * icon from the exe, dev gets nothing unless we hand it over), and desktop
 * notifications — and each one used to guess separately, which is how the
 * tray shipped blank once already.
 *
 * `app.getAppPath()` is the project root in dev and the asar root when
 * packaged, so the paths differ; the bundle-relative one holds in both, and
 * the rest are fallbacks for packaged layouts that keep resources outside the
 * asar. Resolved once and remembered — this answer cannot change at runtime.
 */

import { app, nativeImage } from "electron";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// The main bundle is ESM, where __dirname does not exist. Everything here
// bundles into out/main/index.js, so this points at out/main/ in dev and
// inside the asar when packaged.
const bundleDir = dirname(fileURLToPath(import.meta.url));

let cached: string | null | undefined;

/** Path to the app icon, or null when the build shipped without one. */
export function appIconPath(): string | null {
  if (cached !== undefined) return cached;
  const fromBundle = join(bundleDir, "..", "..", "build");
  const candidates = [
    join(fromBundle, "icon.png"),
    join(fromBundle, "icon.ico"),
    join(app.getAppPath(), "build", "icon.png"),
    join(process.resourcesPath ?? "", "build", "icon.png"),
    join(process.resourcesPath ?? "", "icon.png"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    if (nativeImage.createFromPath(path).isEmpty()) continue;
    cached = path;
    return cached;
  }
  // Say so rather than installing a blank icon silently, which is exactly how
  // this went unnoticed the first time.
  console.warn(
    `[icon] no app icon found (looked in: ${candidates.join(", ")})`,
  );
  cached = null;
  return cached;
}

/** The icon as an image, optionally resized (Windows wants 16px in the tray). */
export function appIconImage(size?: number): Electron.NativeImage {
  const path = appIconPath();
  if (!path) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(path);
  if (img.isEmpty()) return img;
  return size ? img.resize({ width: size, height: size }) : img;
}
