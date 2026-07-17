/**
 * The Google Cloud walkthrough, shared by every Google OAuth service — one
 * Desktop client covers them all, so only the API to enable differs.
 *
 * Step by step because each omission fails blaming the wrong thing: no API →
 * 403 after a perfect sign-in; no test user → "access_denied, app not
 * verified", which reads as if the app were broken; still in Testing → works,
 * then silently dies in about a week.
 */

import type { SetupStep } from "./types.js";

export function googleSetupSteps(api: {
  name: string;
  url: string;
}): SetupStep[] {
  return [
    {
      text: "Open Google Cloud Console and create a project (or pick one you already have).",
      url: "https://console.cloud.google.com/projectcreate",
      urlLabel: "New project",
    },
    {
      text: `Enable the ${api.name} for that project — without it every call comes back 403, even after a perfect sign-in.`,
      url: api.url,
      urlLabel: `Enable ${api.name}`,
    },
    {
      text: "Credentials → Create credentials → OAuth client ID. Application type: Desktop app. Name it anything. Create — then keep the client ID and secret (the JSON download has both).",
      url: "https://console.cloud.google.com/apis/credentials",
      urlLabel: "Credentials",
    },
    {
      text: "Audience → Test users → Add users → your own Gmail address. Miss this and sign-in dies with “access_denied — app not verified”, as if the app were broken. It isn't: you're just not on your own guest list.",
      url: "https://console.cloud.google.com/auth/audience",
      urlLabel: "Audience",
    },
    {
      text: "Same page: Publish app. Optional, but while it stays in “Testing” Google expires the sign-in about every 7 days and the connector quietly stops. Verification isn't needed — that's for handing the app to other people.",
      url: "https://console.cloud.google.com/auth/audience",
      urlLabel: "Audience",
    },
    {
      text: "Paste the client ID and secret below, then Sign in with Google. The browser will warn “Google hasn't verified this app” — expected, it's your own client: Advanced → Go to … → Allow.",
    },
  ];
}
