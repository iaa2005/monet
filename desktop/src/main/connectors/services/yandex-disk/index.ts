/**
 * YandexDisk — files over WebDAV with a Files-type app password.
 * webdav.yandex.ru answers PROPFIND with `Basic realm="Yandex.Disk"`.
 */

import icon from "./icon.svg?raw";
import { makeWebdavOps } from "../../lib/files.js";
import { yandexAuthHint, yandexSetupSteps } from "../yandex-setup.js";
import type { ConnectorService } from "../types.js";

const ops = makeWebdavOps({
  url: "https://webdav.yandex.ru",
  authHint: yandexAuthHint("FILES (WebDAV)"),
});

export const YandexDisk: ConnectorService = {
  id: "yandex-disk",
  name: "YandexDisk",
  company: "Yandex",
  description: "Files on Disk: list, read, write.",
  iconSvg: icon,
  auth: {
    kind: "password",
    fields: [
      { key: "username", label: "Login", placeholder: "you@yandex.ru" },
      {
        key: "password",
        label: "App password — “Files (WebDAV)” type",
        secret: true,
      },
    ],
  },
  credUrl: "https://id.yandex.ru/security/app-passwords",
  credLabel: "Create app password",
  note: "A new app password only starts working 2–3 hours after creation — a fresh one returns 401. Don't recreate it; wait.",
  setupSteps: yandexSetupSteps({ type: "Files (WebDAV)" }),
  capabilities: { files: ops },
  test: (acct) => ops.list(acct, { path: "/" }),
  promptHint:
    "YandexDisk is the user's real drive — confirm before overwriting or deleting.",
};
