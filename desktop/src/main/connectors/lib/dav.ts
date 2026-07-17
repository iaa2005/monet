/**
 * Shared CalDAV/CardDAV library (tsdav). Calendar and contact services call
 * makeCaldavOps()/makeCarddavOps() with their endpoint, optional principal
 * template, auth mode and their own 401 wording.
 *
 * Two ways to authenticate, same code: Basic with an app password (Yandex), or
 * Google OAuth (Google refuses a password here — its `basic realm` challenge is
 * a leftover; believing it once cost three rounds of debugging).
 *
 * Events are raw iCalendar, parsed line-wise: a full iCal library is heavier
 * than the few fields the agent needs.
 */

import { createDAVClient } from "tsdav";
import { fetchRetry } from "../../net-fetch.js";
import { GOOGLE_TOKEN_URL, googleAccessToken } from "../oauth/google.js";
import { patchSecret } from "../store.js";
import type {
  CalendarOps,
  ContactOps,
  ResolvedAccount,
} from "../services/types.js";

type Kind = "caldav" | "carddav";

export interface DavConfig {
  url: string;
  /** Principal URL with `{username}` substituted — for servers that don't
   * answer discovery (Google serves no current-user-principal at its root, so
   * tsdav dead-ends on "cannot find principalUrl" without this). */
  principalTemplate?: string;
  /** Authenticate with the account's Google OAuth tokens instead of Basic. */
  googleOauth?: boolean;
  /** Appended to auth-ish failures — the service's own wording. */
  authHint?: string;
}

async function makeClient(cfg: DavConfig, kind: Kind, acct: ResolvedAccount) {
  const username = acct.account.username;
  const oauth = !!(cfg.googleOauth && acct.secret.refreshToken);

  if (!oauth && !acct.secret.password)
    throw new Error(
      cfg.googleOauth
        ? `${acct.account.label} isn't signed in. Connect it again in Settings → Connectors.`
        : `No app password stored for ${acct.account.label}. Reconnect it in Settings → Connectors.`,
    );

  // Refresh up front rather than leaving it to tsdav, whose refresh returns {}
  // on failure and then sends the request unauthenticated — an expired grant
  // would surface as a bogus "wrong app password".
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
    // tsdav discards the server's reply. Ask ourselves and quote it — Google's
    // reply is usually the whole answer ("API has not been used in project…").
    if (oauth && principalUrl && /principalUrl|homeUrl/i.test(msg)) {
      const said = await davSays(
        principalUrl,
        credentials.accessToken as string,
      );
      if (said) throw new Error(`${acct.service.name} said: ${said}`);
    }
    // tsdav collapses everything to "cannot find …" (fetchHomeUrl has no 401
    // branch at all), so name what's checkable, in the service's words.
    if (/principalUrl|homeUrl|401|credentials/i.test(msg))
      throw new Error(
        `Couldn't open ${kind === "caldav" ? "the calendar" : "contacts"} for “${username}” on ${acct.service.name}.` +
          (cfg.authHint ? ` ${cfg.authHint}` : "") +
          ` (Underlying: ${msg})`,
      );
    throw e;
  }
}

/** PROPFIND the principal directly and report what the server actually said.
 * Returns null when the reply adds nothing. */
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
    const json = /^\s*\{/.test(text)
      ? (JSON.parse(text) as { error?: { message?: string } }).error?.message
      : null;
    const said =
      json ?? text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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

export function makeCaldavOps(cfg: DavConfig): CalendarOps {
  return {
    async calendars(acct) {
      const { dav, account } = await makeClient(cfg, "caldav", acct);
      const cals = await dav.fetchCalendars({ account });
      const text = cals
        .map((cal) => {
          const name =
            typeof cal.displayName === "string" ? cal.displayName : "(unnamed)";
          return `${name}  —  ${cal.url}`;
        })
        .join("\n");
      return { ok: true, text: text || "(no calendars)" };
    },

    async events(acct, opts) {
      const { dav, account } = await makeClient(cfg, "caldav", acct);
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
          return [dtstart, summary || "(no title)", loc]
            .filter(Boolean)
            .join("  ");
        })
        .sort();
      return {
        ok: true,
        text: rows.length
          ? `${typeof cal.displayName === "string" ? cal.displayName : "calendar"} — next ${days}d:\n${rows.join("\n")}`
          : `No events in the next ${days} days.`,
      };
    },

    async create(acct, opts) {
      const { dav, account } = await makeClient(cfg, "caldav", acct);
      const cals = await dav.fetchCalendars({ account });
      const cal = opts.calendarUrl
        ? cals.find((x) => x.url === opts.calendarUrl)
        : cals[0];
      if (!cal) return { ok: false, text: "", error: "No such calendar." };

      const start = new Date(opts.start);
      if (Number.isNaN(start.getTime()))
        return { ok: false, text: "", error: `Unparseable start: ${opts.start}` };
      const end = opts.end
        ? new Date(opts.end)
        : new Date(start.getTime() + 3_600_000);
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
      return {
        ok: true,
        text: `Created “${opts.title}” at ${start.toISOString()}.`,
      };
    },
  };
}

export function makeCarddavOps(cfg: DavConfig): ContactOps {
  return {
    async list(acct, opts) {
      const { dav, account } = await makeClient(cfg, "carddav", acct);
      const books = await dav.fetchAddressBooks({ account });
      if (!books.length) return { ok: true, text: "(no address books)" };
      const book = books[0];

      let cards;
      try {
        cards = await dav.fetchVCards({ addressBook: book });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Yandex answers the enumeration REPORT (addressbook-query) with
        // 403 <supported-report/> — it simply doesn't implement it. Enumerate
        // with plain PROPFIND Depth:1 instead (baseline WebDAV, universally
        // supported) and hand the urls over: fetchVCards then skips the REPORT
        // and multigets the cards directly.
        if (!/supported-report|Collection query failed/i.test(msg)) throw e;
        const listing = await dav.propfind({
          url: book.url,
          props: { "d:getetag": {} },
          depth: "1",
        });
        const objectUrls = listing
          .map((r) => r.href ?? "")
          .filter((h) => h && !h.endsWith("/"));
        try {
          cards = await dav.fetchVCards({ addressBook: book, objectUrls });
        } catch {
          // Some servers lack multiget too — fall back to plain GETs.
          cards = await dav.fetchVCards({
            addressBook: book,
            objectUrls,
            useMultiGet: false,
          });
        }
      }

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
    },
  };
}
