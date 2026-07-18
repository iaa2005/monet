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

const byId = new Map(SERVICES.map((s) => [s.id, s]));

export function getService(id: string): ConnectorService | undefined {
  return byId.get(id);
}

/** Services implementing a capability ("mail", "files", "mcp", …). */
export function servicesWithCapability(
  cap: keyof ServiceCapabilities,
): ConnectorService[] {
  return SERVICES.filter((s) => s.capabilities[cap] != null);
}
