/**
 * Does a press of the Voice Mode button open the menu, or Voice Mode?
 *
 * The bug this guards: Radix opens a DropdownMenu from its trigger's
 * pointerdown, synchronously, while the readiness check is still in flight —
 * so the "not set up" menu appeared on every press, with every model
 * downloaded. The guard is that the trigger's own handlers are composed with
 * checkForDefaultPrevented, which is a property of Radix, not of our code.
 * If a Radix upgrade drops that, this fails instead of the feature.
 */

import { composeEventHandlers } from "@radix-ui/primitive";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A stand-in for the trigger's event object: only defaultPrevented matters.
const fakeEvent = (): { defaultPrevented: boolean; preventDefault: () => void } => {
  const e = {
    defaultPrevented: false,
    preventDefault: (): void => {
      e.defaultPrevented = true;
    },
  };
  return e;
};

// ── our handler prevents; Radix's must not run ────────────────────────
{
  let radixRan = false;
  const composed = composeEventHandlers(
    (e: ReturnType<typeof fakeEvent>) => e.preventDefault(),
    () => {
      radixRan = true;
    },
  );
  composed(fakeEvent() as never);
  check("preventDefault on pointerdown suppresses Radix's open", !radixRan);
}

// ── without preventing, Radix's handler DOES run ──────────────────────
{
  let radixRan = false;
  const composed = composeEventHandlers(
    () => {},
    () => {
      radixRan = true;
    },
  );
  composed(fakeEvent() as never);
  check("without it, Radix opens on its own (the bug)", radixRan);
}

// ── the readiness branch: what a press decides ────────────────────────
type R = { ready: boolean } | null;
const decide = (r: R): "voice" | "menu" => (!r || r.ready ? "voice" : "menu");
check("everything downloaded → opens Voice Mode", decide({ ready: true }) === "voice");
check("something missing → opens the menu", decide({ ready: false }) === "menu");
check("no answer at all → does not block the feature", decide(null) === "voice");

console.log(failures === 0 ? "\nvoice button: PASS" : `\nvoice button: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
