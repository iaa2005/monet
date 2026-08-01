/**
 * Dictation settings on disk — the real module, under real Electron.
 *
 * They moved out of localStorage because that store is keyed by ORIGIN, and
 * the dev renderer's origin carries the vite port: when the port is taken vite
 * moves to the next one, the app comes up on a new origin with an empty store,
 * and the user's endpoint and API key look wiped. The data dir has no such
 * property.
 *
 * Runs under Electron because safeStorage is an Electron API and the point of
 * the move is encryption AT REST — a probe that stubbed it would be asserting
 * nothing. src/main/stt-settings.ts is bundled here (electron left external)
 * and required, so these are claims about the shipped code.
 *
 *   node scripts/build-stt-probe.mjs && electron scripts/stt-settings-probe.cjs
 */
const { app, safeStorage } = require("electron");
const { mkdtempSync, readFileSync, existsSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!pass) failures++;
};

app.whenReady().then(() => {
  // A scratch data dir the bundled stub will use — never the user's own.
  const dir = mkdtempSync(join(tmpdir(), "monet-stt-"));
  process.env.MONET_STT_PROBE_DIR = dir;

  // Bundled by scripts/build-stt-probe.mjs — esbuild's sync API deadlocks
  // inside Electron's main process, so that step runs in plain Node first.
  const store = require(join(__dirname, "..", "out-probe", "stt-settings.cjs"));

  check(
    "safeStorage is available here (so the encryption claims mean something)",
    safeStorage.isEncryptionAvailable(),
  );

  // ── 1. Defaults, before anything is written ─────────────────────────
  {
    const s = store.getSttSettings();
    check("a fresh install reads defaults, not undefined", s.engine === "local", s.engine);
    check("with no key and no endpoint", s.key === "" && s.endpoint === "", JSON.stringify(s));
  }

  // ── 2. A patch saves without erasing its neighbours ─────────────────
  const KEY = "sk-secret-value-42";
  {
    store.setSttSettings({ engine: "cloud", endpoint: "https://api.x/v1" });
    store.setSttSettings({ key: KEY });
    const s = store.getSttSettings();
    check(
      "a later patch keeps the earlier fields",
      s.engine === "cloud" && s.endpoint === "https://api.x/v1",
      JSON.stringify(s),
    );
    check("and the key round-trips exactly", s.key === KEY, s.key);
    check(
      "untouched fields keep their defaults",
      s.localModel === "Xenova/whisper-base",
      s.localModel,
    );
  }

  // ── 3. The file must not hand anyone the key ────────────────────────
  {
    const file = join(dir, "stt.json");
    check("the settings file lands in the data dir", existsSync(file), file);
    const onDisk = readFileSync(file, "utf-8");
    check("the key is NOT readable in it", !onDisk.includes(KEY));
    check(
      "while the non-secret fields stay plain, so a human can read them",
      onDisk.includes("https://api.x/v1") && onDisk.includes("cloud"),
    );
  }

  // ── 4. Survives a corrupt file rather than taking dictation down ────
  {
    const { writeFileSync } = require("fs");
    writeFileSync(join(dir, "stt.json"), "{ not json");
    const s = store.getSttSettings();
    check("a corrupt file reads as defaults", s.engine === "local", JSON.stringify(s));
  }

  console.log(
    failures === 0 ? "\nALL STT-SETTINGS CHECKS PASSED" : `\n${failures} FAILED`,
  );
  app.exit(failures === 0 ? 0 : 1);
});
