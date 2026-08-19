/**
 * The Voice Mode readiness gate, against a data dir we control.
 *
 * Drives the policy through its three interesting states — nothing
 * downloaded, a cloud engine with no key, and the local Whisper engine that
 * needs no preparation — so the button's refusal is exercised rather than
 * assumed.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const dir = process.env.MONET_DATA_DIR!;
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
