/**
 * Google — the company registry. One line per service; adding or removing a
 * Google product touches ONLY this file and its folder. Shared Google-specific
 * code (OAuth client flow in auth.ts, Cloud-console walkthrough in setup.ts)
 * lives beside the products, never in lib/.
 */

import { GoogleGmail } from "./gmail/index.js";
import { GoogleCalendar } from "./calendar/index.js";
import { GoogleContacts } from "./contacts/index.js";
import { GoogleDrive } from "./drive/index.js";
import type { ConnectorService } from "../types.js";

export const googleServices: ConnectorService[] = [
  GoogleGmail,
  GoogleCalendar,
  GoogleContacts,
  GoogleDrive,
];
