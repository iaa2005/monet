/**
 * GoogleDrive — the Drive REST API over the shared Google OAuth client.
 *
 * Drive has no standard protocol at all — no DAV of any kind, only this API
 * behind OAuth (a Basic call answers 403 "unregistered callers"; PROPFIND on
 * drive.google.com is 405). The adapter walks paths segment-by-segment because
 * Drive has no paths, only ids. Scope is full `drive`: `drive.file` only sees
 * files this app itself created, useless for reading the user's own Drive.
 */

import icon from "./icon.svg?raw";
import { driveOps } from "../../lib/gdrive.js";
import { googleSetupSteps } from "../google-setup.js";
import type { ConnectorService } from "../types.js";

export const GoogleDrive: ConnectorService = {
  id: "google-drive",
  name: "GoogleDrive",
  company: "Google",
  description: "Files on Drive: list, read, write; Docs/Sheets export on read.",
  iconSvg: icon,
  auth: {
    kind: "google-oauth",
    scopes: ["https://www.googleapis.com/auth/drive"],
  },
  credUrl: "https://console.cloud.google.com/apis/credentials",
  credLabel: "OAuth client (Desktop app)",
  note: "Reuse the SAME client ID/secret as GoogleCalendar — one client covers every Google connector; only step 2 differs. Drive's scope is a “restricted” one, so expect the unverified-app warning to be firmer. Prefer no setup at all? Google Drive for Desktop mounts Drive as an ordinary drive (usually G:) the file tools already read.",
  setupSteps: googleSetupSteps({
    name: "Google Drive API",
    url: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
  }),
  capabilities: { files: driveOps },
  test: (acct) => driveOps.list(acct, { path: "/" }),
  promptHint:
    "On GoogleDrive, delete moves to its trash; Google Docs/Sheets are exported as text/CSV on read.",
};
