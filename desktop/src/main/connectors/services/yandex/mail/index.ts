/**
 * YandexMail — mail over IMAP/SMTP with a Mail-type app password.
 * imap.yandex.ru advertises AUTH=PLAIN (verified live). IMAP must also be
 * enabled in the mailbox settings, or Yandex refuses every password with
 * "invalid credentials or IMAP is disabled".
 */

import icon from "./icon.svg?raw";
import { makeMailOps } from "../../../lib/protocols/mail.js";
import { yandexAuthHint, yandexSetupSteps } from "../setup.js";
import type { ConnectorService } from "../../types.js";

const ops = makeMailOps({
  imap: { host: "imap.yandex.ru", port: 993, secure: true },
  smtp: { host: "smtp.yandex.ru", port: 465, secure: true },
  authHint: `if IMAP is on in the mailbox settings, then: ${yandexAuthHint("MAIL")}`,
});

export const YandexMail: ConnectorService = {
  id: "yandex-mail",
  name: "YandexMail",
  displayName: "Yandex Mail",
  company: "Yandex",
  description: "Read, search and send email.",
  iconSvg: icon,
  auth: {
    kind: "password",
    fields: [
      { key: "username", label: "Login", placeholder: "you@yandex.ru" },
      { key: "password", label: "App password — “Mail” type", secret: true },
    ],
  },
  credUrl: "https://id.yandex.ru/security/app-passwords",
  credLabel: "Create app password",
  note: "Enable IMAP in Yandex Mail settings first. New app passwords activate 2–3 hours after creation.",
  setupSteps: yandexSetupSteps({
    type: "Mail",
    extra: [
      {
        text: "Yandex Mail → Settings → Mail clients → tick “From the imap.yandex.ru server via IMAP”, and save. Skipping this makes every password look wrong.",
        url: "https://mail.yandex.ru/#setup/client",
        urlLabel: "Mail clients",
      },
    ],
  }),
  capabilities: { mail: ops },
  test: (acct) => ops.folders(acct),
};
