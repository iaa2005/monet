/**
 * Shared Yandex facts, so every Yandex service tells the same truth.
 *
 * The one that cost a whole debugging day: a freshly created app password
 * returns 401 for its first 2–3 HOURS. Yandex's own docs say it verbatim —
 * "Пароль начнет действовать через 2–3 часа" — so a correct password fails,
 * the obvious move is to recreate it, and every recreation restarts the clock.
 * The hint leads with that, because "wrong type, make another" advice here is
 * actively harmful.
 *
 * Second fact: app passwords are scoped PER SERVICE (a Mail password is refused
 * by Disk on principle), so each Yandex service names the type it needs.
 */

import type { SetupStep } from "./types.js";

export const YANDEX_ACTIVATION =
  "Yandex app passwords only start working 2–3 HOURS after creation (per Yandex's own docs) — a brand-new one returns 401 even though it's correct. Don't recreate it; that restarts the clock. Wait, then Test again.";

export function yandexAuthHint(type: string): string {
  return `${YANDEX_ACTIVATION} If it's older than that, check it's the ${type} type — Yandex scopes app passwords per service, so one made for another service is refused here.`;
}

export function yandexSetupSteps(opts: {
  type: string;
  extra?: SetupStep[];
}): SetupStep[] {
  return [
    ...(opts.extra ?? []),
    {
      text: `Create an app password of type “${opts.type}”. A password made for another Yandex service will NOT work — they're scoped per service.`,
      url: "https://id.yandex.ru/security/app-passwords",
      urlLabel: "App passwords",
    },
    {
      text: "Wait 2–3 hours: per Yandex's docs a new app password only starts working then. Testing earlier returns 401 even for a correct password — don't recreate it, that restarts the clock.",
    },
    { text: "Paste your full address and that password below, then Test." },
  ];
}
