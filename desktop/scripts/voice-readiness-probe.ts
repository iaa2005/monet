/**
 * The Voice Mode readiness gate, against a data dir we control.
 *
 * Drives the policy through its three interesting states — nothing
 * downloaded, a cloud engine with no key, and the local Whisper engine that
 * needs no preparation — so the button's refusal is exercised rather than
 * assumed.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Its own folder unless one is handed in: the npm script passes nothing, so
// reading MONET_DATA_DIR and trusting it crashed the probe on mkdirSync
// (undefined) for anyone who ran it the documented way.
const dir = process.env.MONET_DATA_DIR ?? mkdtempSync(join(tmpdir(), "monet-voice-"));
process.env.MONET_DATA_DIR = dir;
mkdirSync(dir, { recursive: true });

const settings = (patch: Record<string, unknown>): void => {
  writeFileSync(
    join(dir, "stt.json"),
    JSON.stringify({
      engine: "ondevice", endpoint: "", key: "", model: "",
      localModel: "iaa2005/whisper-base", nativeModel: "gigaam-v3-rnnt-punct",
      ttsVoice: "F1", ttsLang: "ru", language: "", deviceId: "",
      ...patch,
    }),
  );
};

const { readiness } = await import("../src/main/ipc/voice.js");

let failures = 0;
const check = (name: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

settings({});
let r = await readiness();
check("nothing downloaded → not ready", r.ready, false);
check("  names the missing speech model", /not downloaded/i.test(r.stt.reason), true);
check("  names the missing voice", r.tts.ok, false);

settings({ engine: "cloud", endpoint: "", key: "" });
r = await readiness();
check("cloud without endpoint → not ready", r.stt.ok, false);
check("  says endpoint", /endpoint/i.test(r.stt.reason), true);

settings({ engine: "cloud", endpoint: "https://x/v1", key: "" });
r = await readiness();
check("cloud without key → says key", /api key/i.test(r.stt.reason), true);

settings({ engine: "cloud", endpoint: "https://x/v1", key: "sk-x" });
r = await readiness();
check("cloud fully configured → hearing ok", r.stt.ok, true);

settings({ engine: "local" });
r = await readiness();
check("local whisper needs no prep → hearing ok", r.stt.ok, true);

console.log(failures === 0 ? "\nvoice readiness: PASS" : `\nvoice readiness: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
