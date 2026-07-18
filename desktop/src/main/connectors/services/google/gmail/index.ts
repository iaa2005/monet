/**
 * GoogleGmail — mail over IMAP/SMTP with an app password.
 *
 * The one Google service where a password works: imap.gmail.com advertises
 * AUTH=PLAIN (verified live). Requires 2-Step Verification — Google only issues
 * app passwords then. Gmail's IMAP speaks X-GM-EXT-1, so search uses real Gmail
 * query syntax (from:bob has:attachment) — the shared mail lib detects that.
 */

import icon from "./icon.svg?raw";
import { makeMailOps } from "../../../lib/protocols/mail.js";
import type { ConnectorService } from "../../types.js";

const ops = makeMailOps({
  imap: { host: "imap.gmail.com", port: 993, secure: true },
  smtp: { host: "smtp.gmail.com", port: 465, secure: true },
  authHint:
    "check the app password (16 characters, no spaces) and that 2-Step Verification is on — Google only issues app passwords then.",
});

export const GoogleGmail: ConnectorService = {
  id: "gmail",
  name: "GoogleGmail",
  company: "Google",
  description: "Read, search and send email.",
  iconSvg: icon,
  auth: {
    kind: "password",
    fields: [
      { key: "username", label: "Login", placeholder: "you@gmail.com" },
      {
        key: "password",
        label: "App password (16 characters)",
        secret: true,
      },
    ],
  },
  credUrl: "https://myaccount.google.com/apppasswords",
  credLabel: "Create app password",
  note: "Needs 2-Step Verification turned on — Google only offers app passwords then. Search uses real Gmail query syntax (e.g. from:bob has:attachment).",
  capabilities: { mail: ops },
  test: (acct) => ops.folders(acct),
  promptHint:
    "On GoogleGmail, `query` takes real Gmail search syntax (from:x has:attachment).",
};
