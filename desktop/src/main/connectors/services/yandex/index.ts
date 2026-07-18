/**
 * Yandex — the company registry. One line per service. Shared Yandex wording
 * (app-password hints, the setup walkthrough) lives in setup.ts beside them.
 */

import { YandexMail } from "./mail/index.js";
import { YandexDisk } from "./disk/index.js";
import { YandexCalendar } from "./calendar/index.js";
import { YandexContacts } from "./contacts/index.js";
import type { ConnectorService } from "../types.js";

export const yandexServices: ConnectorService[] = [
  YandexMail,
  YandexDisk,
  YandexCalendar,
  YandexContacts,
];
