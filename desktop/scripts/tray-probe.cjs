/**
 * Checks the tray gets a real icon, and that the icon will still be there
 * after packaging.
 *
 * The bug: `createTray` built its image with `nativeImage.createEmpty()` — a
 * literally blank picture. The tray item existed, the tooltip worked, and the
 * icon was a hole. Nothing failed, so nothing said anything.
 *
 * Two halves, and the second is the one that would have bitten later:
 *
 *   1. The path resolves and the image is not empty. Anchored to the bundle's
 *      own location, because app.getAppPath() differs between `electron .`,
 *      `electron some/script.js` and a packaged launch.
 *   2. electron-builder actually SHIPS build/icon.png. Its `icon:` entries
 *      only tell the builder what to stamp on the installer and the .exe;
 *      without the file in `files:`, the tray works all through development
 *      and is blank in every build that reaches a user.
 *
 * Runs under Electron (needs nativeImage and Tray), from the repo root.
 */
const { app, nativeImage, Tray } = require("electron");
const { existsSync, readFileSync } = require("fs");
const { join, resolve } = require("path");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

app.whenReady().then(() => {
  // ── 1. The image ─────────────────────────────────────────────────────
  // Mirrors trayImage()'s first two candidates, resolved the way the built
  // bundle at out/main/ resolves them.
  const buildDir = resolve("build");
  const png = join(buildDir, "icon.png");
  const ico = join(buildDir, "icon.ico");

  check("build/icon.png exists", existsSync(png), png);

  if (existsSync(png)) {
    const img = nativeImage.createFromPath(png);
    check("it decodes as an image", !img.isEmpty());
    const size = img.getSize();
    check("with real dimensions", size.width > 0 && size.height > 0, JSON.stringify(size));

    const small = img.resize({ width: 16, height: 16 });
    check("and survives the resize to 16px", !small.isEmpty(), JSON.stringify(small.getSize()));
    // The exact failure being guarded: a blank image is also "not an error".
    check("the 16px copy carries actual pixels", small.toPNG().length > 200, `${small.toPNG().length} bytes`);

    try {
      const tray = new Tray(small);
      check("Tray accepts it", !tray.isDestroyed());
      tray.destroy();
    } catch (e) {
      check("Tray accepts it", false, String(e.message));
    }
  }

  check("build/icon.ico exists as a fallback", existsSync(ico));

  // A blank image must be recognisably blank — the property the old code
  // relied on without noticing.
  check("an empty image reports itself empty", nativeImage.createEmpty().isEmpty());

  // ── 2. Packaging ─────────────────────────────────────────────────────
  const cfgPath = resolve("electron-builder.yml");
  if (!existsSync(cfgPath)) {
    check("electron-builder.yml exists", false, cfgPath);
  } else {
    const cfg = readFileSync(cfgPath, "utf8");
    const filesBlock = cfg.slice(cfg.indexOf("files:"), cfg.indexOf("asarUnpack:"));
    check(
      "electron-builder ships build/icon.png inside the app",
      /^\s*-\s*build\/icon\.png\s*$/m.test(filesBlock),
      "add `- build/icon.png` under `files:` — the `icon:` keys only stamp the installer",
    );
  }

  console.log(failures ? `\n${failures} FAILED` : "\nALL TRAY CHECKS PASSED");
  app.exit(failures ? 1 : 0);
});
