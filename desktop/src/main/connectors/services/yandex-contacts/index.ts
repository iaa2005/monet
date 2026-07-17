/**
 * YandexContacts — CardDAV with a Contacts-type app password.
 * The only Yandex connector confirmed end-to-end so far (a real Test passed
 * against carddav.yandex.ru), which is how we know the code path works and the
 * 401s elsewhere are password-side.
 */

import icon from "./icon.svg?raw";
import { makeCarddavOps } from "../../lib/dav.js";
import { yandexAuthHint, yandexSetupSteps } from "../yandex-setup.js";
import type { ConnectorService } from "../types.js";

const ops = makeCarddavOps({
  url: "https://carddav.yandex.ru",
  authHint: yandexAuthHint("CONTACTS (CardDAV)"),
});

export const YandexContacts: ConnectorService = {
  id: "yandex-contacts",
  name: "YandexContacts",
  company: "Yandex",
  description: "Look up people: names, emails, phones. Read-only.",
  iconSvg: icon,
  auth: {
    kind: "password",
    fields: [
      { key: "username", label: "Login", placeholder: "you@yandex.ru" },
      {
        key: "password",
        label: "App password — “Contacts (CardDAV)” type",
        secret: true,
      },
    ],
  },
  credUrl: "https://id.yandex.ru/security/app-passwords",
  credLabel: "Create app password",
  note: "A new app password only starts working 2–3 hours after creation — a fresh one returns 401. Don't recreate it; wait.",
  setupSteps: yandexSetupSteps({ type: "Contacts (CardDAV)" }),
  capabilities: { contacts: ops },
  test: (acct) => ops.list(acct, { limit: 1 }),
};
