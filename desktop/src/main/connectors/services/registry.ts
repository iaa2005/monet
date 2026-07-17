/**
 * The service registry — the ONLY place a service touches shared code.
 *
 * Adding a service: create its folder (see README.md), then add TWO lines here
 * — the import and the array entry. Removing one: delete the two lines and the
 * folder. Nothing else in the codebase names individual services.
 *
 * Order here is display order in Settings → Connectors.
 */

import { GoogleGmail } from "./gmail/index.js";
import { GoogleCalendar } from "./google-calendar/index.js";
import { GoogleContacts } from "./google-contacts/index.js";
import { GoogleDrive } from "./google-drive/index.js";
import { YandexMail } from "./yandex-mail/index.js";
import { YandexDisk } from "./yandex-disk/index.js";
import { YandexCalendar } from "./yandex-calendar/index.js";
import { YandexContacts } from "./yandex-contacts/index.js";
import { Telegram } from "./telegram/index.js";
import { GitHub } from "./github/index.js";
import { Notion } from "./notion/index.js";
import { Slack } from "./slack/index.js";
import { Linear } from "./linear/index.js";
import { Sentry } from "./sentry/index.js";
import type { ConnectorService, ServiceCapabilities } from "./types.js";

export const SERVICES: ConnectorService[] = [
  GoogleGmail,
  GoogleCalendar,
  GoogleContacts,
  GoogleDrive,
  YandexMail,
  YandexDisk,
  YandexCalendar,
  YandexContacts,
  Telegram,
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
