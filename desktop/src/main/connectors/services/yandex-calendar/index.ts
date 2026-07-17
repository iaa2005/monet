/**
 * YandexCalendar — CalDAV with a Calendar-type app password.
 * caldav.yandex.ru advertises a principal, so discovery needs no template.
 */

import icon from "./icon.svg?raw";
import { makeCaldavOps } from "../../lib/dav.js";
import { yandexAuthHint, yandexSetupSteps } from "../yandex-setup.js";
import type { ConnectorService } from "../types.js";

const ops = makeCaldavOps({
  url: "https://caldav.yandex.ru",
  authHint: yandexAuthHint("CALENDAR (CalDAV)"),
});

export const YandexCalendar: ConnectorService = {
  id: "yandex-calendar",
  name: "YandexCalendar",
  company: "Yandex",
  description: "Events and availability; can create events.",
  iconSvg: icon,
  auth: {
    kind: "password",
    fields: [
      { key: "username", label: "Login", placeholder: "you@yandex.ru" },
      {
        key: "password",
        label: "App password — “Calendar (CalDAV)” type",
        secret: true,
      },
    ],
  },
  credUrl: "https://id.yandex.ru/security/app-passwords",
  credLabel: "Create app password",
  note: "New app passwords activate 2–3 hours after creation — a fresh one returns 401.",
  setupSteps: yandexSetupSteps({ type: "Calendar (CalDAV)" }),
  capabilities: { calendar: ops },
  test: (acct) => ops.calendars(acct),
};
