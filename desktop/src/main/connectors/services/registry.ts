/**
 * The service registry — the ONLY place services touch shared code.
 *
 * Companies with several products keep their own registry (google/index.ts,
 * yandex/index.ts, …) and appear here as one spread; single-service companies
 * are listed directly. Adding a service touches its company index (or this
 * file, for a standalone); adding a company adds one spread line here.
 * Removing either is deleting the folder plus its single line.
 *
 * Order here is display order in Settings → Connectors.
 */

import { googleServices } from "./google/index.js";
import { yandexServices } from "./yandex/index.js";
import { telegramServices } from "./telegram/index.js";
import { GitHub } from "./github/index.js";
import { Notion } from "./notion/index.js";
import { Slack } from "./slack/index.js";
import { Linear } from "./linear/index.js";
import { Sentry } from "./sentry/index.js";
import type { ConnectorService, ServiceCapabilities } from "./types.js";

export const SERVICES: ConnectorService[] = [
  ...googleServices,
  ...yandexServices,
  ...telegramServices,
  GitHub,
  Notion,
  Slack,
  Linear,
  Sentry,
];

export const BUILTIN_IDS = new Set(SERVICES.map((s) => s.id));

// ─── Store-installed services ───────────────────────────────────────────────
// Manifest connectors (see manifest.ts) join the same registry at runtime.
// They are DATA validated into ConnectorServices; store-catalog.ts loads them
// from disk and calls setInstalledServices on install/remove/startup.

let installed: ConnectorService[] = [];

export function setInstalledServices(list: ConnectorService[]): void {
  // Builtin always wins an id clash (manifestToService refuses them anyway).
  installed = list.filter((s) => !BUILTIN_IDS.has(s.id));
}

/** Builtin + store-installed, the list every consumer should use. */
export function allServices(): ConnectorService[] {
  return installed.length ? [...SERVICES, ...installed] : SERVICES;
}

export function getService(id: string): ConnectorService | undefined {
  return (
    SERVICES.find((s) => s.id === id) ?? installed.find((s) => s.id === id)
  );
}

/** Services implementing a capability ("mail", "files", "mcp", …). */
export function servicesWithCapability(
  cap: keyof ServiceCapabilities,
): ConnectorService[] {
  return allServices().filter((s) => s.capabilities[cap] != null);
}
