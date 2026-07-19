/**
 * GoogleCalendar — CalDAV over the user's own Google OAuth client.
 *
 * Google refuses an app password here, proven the only way that settles it: the
 * SAME password Gmail accepts over IMAP gets the GData error `loginRequired`
 * from CalDAV. (The `basic realm="Google APIs"` challenge is a leftover and
 * means nothing.) The principal is spelled out because Google serves no
 * current-user-principal at the root — discovery dead-ends without it.
 */

import icon from "./icon.svg?raw";
import { makeCaldavOps } from "../../../lib/protocols/dav.js";
import { googleDavCredentials } from "../auth.js";
import { googleSetupSteps } from "../setup.js";
import type { ConnectorService } from "../../types.js";

const ops = makeCaldavOps({
  url: "https://apidata.googleusercontent.com/caldav/v2/",
  principalTemplate:
    "https://apidata.googleusercontent.com/caldav/v2/{username}/user",
  oauth: googleDavCredentials,
  authHint:
    "The sign-in worked, so check the Google Calendar API is enabled for your OAuth client in Google Cloud, and that the consent screen granted the scope.",
});

export const GoogleCalendar: ConnectorService = {
  id: "google-calendar",
  name: "GoogleCalendar",
  displayName: "Google Calendar",
  company: "Google",
  description: "Events and availability; can create events.",
  iconSvg: icon,
  auth: {
    kind: "google-oauth",
    scopes: ["https://www.googleapis.com/auth/calendar"],
  },
  credUrl: "https://console.cloud.google.com/apis/credentials",
  credLabel: "OAuth client (Desktop app)",
  note: "Google refuses an app password here, so this signs in instead. One client covers every Google connector.",
  setupSteps: googleSetupSteps({
    name: "Google Calendar API",
    url: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
  }),
  capabilities: { calendar: ops },
  test: (acct) => ops.calendars(acct),
};
