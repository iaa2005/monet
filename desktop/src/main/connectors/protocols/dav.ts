/**
 * CalDAV + CardDAV adapter — calendars and contacts.
 *
 * One adapter, two protocols: tsdav speaks both, and Google and Yandex both
 * accept Basic auth with an app password here (Google CardDAV answers
 * `basic realm="Google APIs"`), so this is the OAuth-free path to a calendar.
 *
 * Events are emitted/parsed as raw iCalendar. A full iCal library would be
 * heavier than the few fields an agent actually needs, so we do minimal
 * line-based extraction and keep VEVENT generation explicit.
 */

import { createDAVClient } from "tsdav";
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
  const password = acct.secret.password;
  if (!password)
    throw new Error(
      `No app password stored for ${acct.account.label}. Reconnect it in Settings → Connectors.`,
    );
  const username = acct.account.username;
  const dav = await createDAVClient({
    serverUrl: cfg.url,
    credentials: { username, password },
    authMethod: "Basic",
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
    // tsdav's discovery errors are near-useless on their own: fetchHomeUrl has
    // no 401 branch at all, so a wrong app password surfaces as "cannot find
    // homeUrl" — identical to a genuinely wrong URL. Translate into the two
    // things the user can actually check, cheapest first.
    if (/principalUrl|homeUrl/i.test(msg))
      throw new Error(
        `Couldn't open ${kind === "caldav" ? "the calendar" : "contacts"} for “${username}” on ${acct.preset.name}. ` +
          `Most likely the app password is wrong or expired — try Test after re-pasting it. ` +
          `Otherwise ${kind === "caldav" ? "CalDAV" : "CardDAV"} may not be enabled for this account, or the login isn't the full address. ` +
          `(Underlying: ${msg})`,
      );
    throw e;
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
