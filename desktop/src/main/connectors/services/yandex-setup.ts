/**
 * Shared Yandex facts, so every Yandex service tells the same short truth.
 *
 * The three real causes of a Yandex 401, in the order they actually bit:
 *  1. A typo in the login — one letter off gives the exact same 401 as a bad
 *     password, and no password-side check can catch it.
 *  2. Wrong app-password type — Yandex scopes them per service.
 *  3. A password younger than 2–3 hours — Yandex's docs: new app passwords
 *     activate with a delay, and recreating one restarts the clock.
 */

import type { SetupStep } from "./types.js";

export function yandexAuthHint(type: string): string {
  return `check the login is typed EXACTLY (a one-letter typo gives this same 401), the app password is the ${type} type, and that it's older than 2–3 hours — new ones activate with a delay, so don't recreate it.`;
}

export function yandexSetupSteps(opts: {
  type: string;
  extra?: SetupStep[];
}): SetupStep[] {
  return [
    ...(opts.extra ?? []),
    {
      text: `Create an app password of type “${opts.type}” — Yandex scopes them per service.`,
      url: "https://id.yandex.ru/security/app-passwords",
      urlLabel: "App passwords",
    },
    {
      text: "Paste your address EXACTLY as Yandex shows it, plus that password. If Test says 401 with everything correct, wait 2–3 hours — new app passwords activate with a delay.",
    },
  ];
}
