/**
 * GoogleContacts — the People API over the shared Google OAuth client.
 *
 * NOT CardDAV: Google's CardDAV answers a valid OAuth token with a 404 HTML
 * page, and its principal paths aren't documented anywhere reachable — three
 * guesses missed three times. People API is what Google documents for
 * contacts; it takes the same Bearer token as Drive and returns JSON that says
 * what it means. Read-only, which is what contacts are for here.
 */

import icon from "./icon.svg?raw";
import { peopleList } from "./api.js";
import { googleSetupSteps } from "../setup.js";
import type { ConnectorService } from "../../types.js";

export const GoogleContacts: ConnectorService = {
  id: "google-contacts",
  name: "GoogleContacts",
  displayName: "Google Contacts",
  company: "Google",
  description: "Look up people: names, emails, phones. Read-only.",
  iconSvg: icon,
  auth: {
    kind: "google-oauth",
    scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
  },
  credUrl: "https://console.cloud.google.com/apis/credentials",
  credLabel: "OAuth client (Desktop app)",
  note: "Reuse the SAME client ID/secret as GoogleCalendar. If you connected this before the People API switch, sign in again — the saved sign-in lacks the new permission.",
  setupSteps: googleSetupSteps({
    name: "People API",
    url: "https://console.cloud.google.com/apis/library/people.googleapis.com",
  }),
  capabilities: { contacts: { list: peopleList } },
  test: (acct) => peopleList(acct, { limit: 1 }),
};
