/**
 * CalDAV + CardDAV adapter — calendars and contacts.
 *
 * One adapter, two protocols, two ways to authenticate: Yandex takes an app
 * password, Google refuses one and wants OAuth. (Google's endpoints do send a
 * `basic realm="Google APIs"` challenge — it's a leftover. Believing it cost
 * three rounds of debugging aimed at a password that was never the problem.)
 *
 * Events are emitted/parsed as raw iCalendar. A full iCal library would be
 * heavier than the few fields an agent actually needs, so we do minimal
 * line-based extraction and keep VEVENT generation explicit.
 */

import { createDAVClient } from "tsdav";
import { fetchRetry } from "../../net-fetch.js";
import { GOOGLE_TOKEN_URL, googleAccessToken } from "../oauth/google.js";
import { patchSecret } from "../store.js";
import type { ProtocolResult, ResolvedAccount } from "../types.js";

type Kind = "caldav" | "carddav";

/**
 * A client plus the account its calls need.
 *
 * `defaultAccountType` is deliberately NOT passed: that makes the client
 * discover the account eagerly, PROPFINDing the root for
 * `current-user-principal` — which Google doesn't serve, so it dies with
 * "cannot find principalUrl" before any calendar is touched. Building the
 * account ourselves lets a preset supply the principal directly (tsdav skips
 * the lookup when `principalUrl` is set) while the home is still discovered
 * from it. Servers that do advertise a principal, like Yandex, take the same
 * path with nothing supplied.
 */
async function client(acct: ResolvedAccount, kind: Kind) {
  const cfg = kind === "caldav" ? acct.preset.caldav : acct.preset.carddav;
  if (!cfg)
    throw new Error(`${acct.preset.name} has no ${kind.toUpperCase()} endpoint.`);
  const username = acct.account.username;

  // Two ways in, same adapter. Google refuses an app password for DAV and wants
  // OAuth; Yandex takes the password. tsdav handles the token dance itself —
  // given clientId/secret/refreshToken it refreshes an expired access token and
  // writes the new one back into this credentials object, which is why it's a
  // named variable: we persist whatever it leaves there.
  const oauth = !!(acct.preset.oauth && acct.secret.refreshToken);

  if (!oauth && !acct.secret.password)
    throw new Error(
      acct.preset.oauth
        ? `${acct.account.label} isn't signed in. Connect it again in Settings → Connectors.`
        : `No app password stored for ${acct.account.label}. Reconnect it in Settings → Connectors.`,
    );

  // Refresh up front rather than leaving it to tsdav, whose refresh returns {}
  // on failure and then sends the request unauthenticated — an expired grant
  // would arrive as a bogus "wrong app password". Handing it a token that's
  // already valid means its own refresh path never runs.
  let credentials;
  if (oauth) {
    const tokens = await googleAccessToken(acct.secret);
    if (tokens.accessToken !== acct.secret.accessToken)
      patchSecret(acct.account.id, tokens);
    credentials = {
      clientId: acct.secret.clientId,
      clientSecret: acct.secret.clientSecret,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      expiration: tokens.expiry,
      tokenUrl: GOOGLE_TOKEN_URL,
    };
  } else {
    credentials = { username, password: acct.secret.password };
  }

  const dav = await createDAVClient({
    serverUrl: cfg.url,
    credentials,
    authMethod: oauth ? "Oauth" : "Basic",
  });

  const principalUrl = cfg.principalTemplate?.replace(
    "{username}",
    encodeURIComponent(username),
  );
  try {
    const account = await dav.createAccount({
      account: {
        serverUrl: cfg.url,
        accountType: kind,
        // rootUrl too, or tsdav still runs service discovery to find one.
        ...(principalUrl ? { rootUrl: cfg.url, principalUrl } : {}),
      },
      loadCollections: false,
    });
    return { dav, account };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // tsdav discards the server's reply, so ask it ourselves and quote it. For
    // Google that reply is the whole answer — a disabled API says exactly that,
    // the same way Drive's did, instead of hiding behind "cannot find homeUrl".
    if (oauth && principalUrl && /principalUrl|homeUrl/i.test(msg)) {
      const said = await davSays(principalUrl, credentials.accessToken as string);
      if (said) throw new Error(`${acct.preset.name} said: ${said}`);
    }
    // Fallback wording: tsdav collapses everything to "cannot find …", and
    // fetchHomeUrl has no 401 branch at all, so a wrong app password looks
    // exactly like a wrong URL. Name what's worth checking, cheapest first.
    if (/principalUrl|homeUrl/i.test(msg))
      throw new Error(
        `Couldn't open ${kind === "caldav" ? "the calendar" : "contacts"} for “${username}” on ${acct.preset.name}. ` +
          (oauth
            ? `The sign-in worked, so check the ${kind === "caldav" ? "Calendar" : "CardDAV"} API is enabled for your OAuth client in Google Cloud, and that the consent screen granted the scope.`
            : `Most likely the app password is wrong or expired — try Test after re-pasting it. ` +
              `Otherwise ${kind === "caldav" ? "CalDAV" : "CardDAV"} may not be enabled for this account, or the login isn't the full address.`) +
          ` (Underlying: ${msg})`,
      );
    throw e;
  }
}

/**
 * Ask the principal URL directly and report what the server actually said.
 *
 * Everything in tsdav's discovery collapses to "cannot find principalUrl" or
 * "cannot find homeUrl" — the response is dropped. Google's response, though,
 * usually names the problem outright ("Calendar API has not been used in
 * project N before or it is disabled"), which is the difference between a fix
 * and an afternoon. Returns null when the reply adds nothing.
 */
async function davSays(url: string, bearer: string): Promise<string | null> {
  try {
    const res = await fetchRetry(url, {
      method: "PROPFIND",
      headers: {
        authorization: `Bearer ${bearer}`,
        depth: "0",
        "content-type": "application/xml; charset=utf-8",
      },
      body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
    });
    if (res.ok) return null; // reachable — the failure is elsewhere
    const text = (await res.text().catch(() => "")).trim();
    // Google answers JSON for API-level problems and XML for DAV ones; the JSON
    // message is the useful one, the XML is usually noise.
    const json = /^\s*\{/.test(text)
      ? (JSON.parse(text) as { error?: { message?: string } }).error?.message
      : null;
    const said = json ?? text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return said ? `${res.status} — ${said.slice(0, 400)}` : `HTTP ${res.status}`;
  } catch {
    return null;
  }
}

/** Pull one property out of an iCal/vCard blob. */
function field(blob: string, name: string): string {
  const m = new RegExp(`^${name}[^:\\r\\n]*:(.*)$`, "im").exec(blob);
  return m?.[1]?.trim() ?? "";
}

/** iCal UTC stamp: 20260716T134500Z */
function ical(dt: Date): string {
  return dt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export async function calendarList(acct: ResolvedAccount): Promise<ProtocolResult> {
  const { dav, account } = await client(acct, "caldav");
  const cals = await dav.fetchCalendars({ account });
  const text = cals
    .map((cal) => {
      const name =
        typeof cal.displayName === "string" ? cal.displayName : "(unnamed)";
      return `${name}  —  ${cal.url}`;
    })
    .join("\n");
  return { ok: true, text: text || "(no calendars)" };
}

export async function calendarEvents(
  acct: ResolvedAccount,
  opts: { calendarUrl?: string; days?: number },
): Promise<ProtocolResult> {
  const { dav, account } = await client(acct, "caldav");
  const cals = await dav.fetchCalendars({ account });
  const cal = opts.calendarUrl
    ? cals.find((x) => x.url === opts.calendarUrl)
    : cals[0];
  if (!cal) return { ok: false, text: "", error: "No such calendar." };

  const days = Math.min(Math.max(opts.days ?? 7, 1), 90);
  const start = new Date();
  const end = new Date(Date.now() + days * 86_400_000);
  const objects = await dav.fetchCalendarObjects({
    calendar: cal,
    timeRange: { start: start.toISOString(), end: end.toISOString() },
  });

  const rows = objects
    .map((o) => {
      const d = o.data ?? "";
      const summary = field(d, "SUMMARY");
      const dtstart = field(d, "DTSTART");
      const loc = field(d, "LOCATION");
      return [dtstart, summary || "(no title)", loc].filter(Boolean).join("  ");
    })
    .sort();
  return {
    ok: true,
    text: rows.length
      ? `${typeof cal.displayName === "string" ? cal.displayName : "calendar"} — next ${days}d:\n${rows.join("\n")}`
      : `No events in the next ${days} days.`,
  };
}

export async function calendarCreate(
  acct: ResolvedAccount,
  opts: {
    title: string;
    start: string;
    end?: string;
    calendarUrl?: string;
    location?: string;
  },
): Promise<ProtocolResult> {
  const { dav, account } = await client(acct, "caldav");
  const cals = await dav.fetchCalendars({ account });
  const cal = opts.calendarUrl
    ? cals.find((x) => x.url === opts.calendarUrl)
    : cals[0];
  if (!cal) return { ok: false, text: "", error: "No such calendar." };

  const start = new Date(opts.start);
  if (Number.isNaN(start.getTime()))
    return { ok: false, text: "", error: `Unparseable start: ${opts.start}` };
  const end = opts.end ? new Date(opts.end) : new Date(start.getTime() + 3_600_000);
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@monet`;

  const vevent = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Monet//Connectors//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${ical(new Date())}`,
    `DTSTART:${ical(start)}`,
    `DTEND:${ical(end)}`,
    `SUMMARY:${opts.title}`,
    opts.location ? `LOCATION:${opts.location}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");

  await dav.createCalendarObject({
    calendar: cal,
    filename: `${uid}.ics`,
    iCalString: vevent,
  });
  return { ok: true, text: `Created “${opts.title}” at ${start.toISOString()}.` };
}

export async function contactsList(
  acct: ResolvedAccount,
  opts: { query?: string; limit?: number },
): Promise<ProtocolResult> {
  const { dav, account } = await client(acct, "carddav");
  const books = await dav.fetchAddressBooks({ account });
  if (!books.length) return { ok: true, text: "(no address books)" };
  const cards = await dav.fetchVCards({ addressBook: books[0] });

  const q = opts.query?.trim().toLowerCase();
  const rows = cards
    .map((v) => {
      const d = v.data ?? "";
      const fn = field(d, "FN");
      const email = field(d, "EMAIL");
      const tel = field(d, "TEL");
      return [fn, email, tel].filter(Boolean).join("  ");
    })
    .filter((line) => line && (!q || line.toLowerCase().includes(q)))
    .slice(0, Math.min(Math.max(opts.limit ?? 50, 1), 200));

  return { ok: true, text: rows.join("\n") || "(no matching contacts)" };
}
