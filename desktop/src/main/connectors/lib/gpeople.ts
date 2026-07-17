/**
 * Google Contacts via the People API.
 *
 * Not CardDAV. Google's CardDAV endpoint answers a valid OAuth token with a 404
 * HTML page, and I guessed its principal URL three times and was wrong three
 * times — the paths aren't documented anywhere I can reach. People API is what
 * Google actually documents for contacts, it takes the same Bearer token as
 * Drive, and it returns JSON that says what it means. Guessing was the bug; this
 * removes the guess.
 */

import { fetchRetry } from "../../net-fetch.js";
import { googleAccessToken } from "../oauth/google.js";
import { patchSecret } from "../store.js";
import type { ResolvedAccount } from "../services/types.js";
import type { ProtocolResult } from "../types.js";

const API = "https://people.googleapis.com/v1/people/me/connections";
const FIELDS = "names,emailAddresses,phoneNumbers,organizations";

interface Person {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  organizations?: { name?: string }[];
}

export async function peopleList(
  acct: ResolvedAccount,
  opts: { query?: string; limit?: number },
): Promise<ProtocolResult> {
  const tokens = await googleAccessToken(acct.secret);
  if (tokens.accessToken !== acct.secret.accessToken)
    patchSecret(acct.account.id, tokens);

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const url =
    `${API}?personFields=${encodeURIComponent(FIELDS)}&pageSize=${Math.min(limit, 200)}` +
    `&sortOrder=FIRST_NAME_ASCENDING`;
  const res = await fetchRetry(url, {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    // Google names a disabled API outright, so pass it through — that message
    // is what got Drive working in one click.
    const said = body.error?.message ?? `${res.status} ${res.statusText}`;
    // A token granted before this service switched scopes fails exactly here.
    const hint = /insufficient authentication scopes/i.test(said)
      ? " — the saved sign-in predates the required permission. Open the connector and Sign in with Google again."
      : "";
    throw new Error(`GoogleContacts: ${said}${hint}`);
  }
  const { connections } = (await res.json()) as { connections?: Person[] };
  if (!connections?.length) return { ok: true, text: "(no contacts)" };

  const q = opts.query?.trim().toLowerCase();
  const rows = connections
    .map((p) =>
      [
        p.names?.[0]?.displayName,
        p.emailAddresses?.[0]?.value,
        p.phoneNumbers?.[0]?.value,
        p.organizations?.[0]?.name,
      ]
        .filter(Boolean)
        .join("  "),
    )
    .filter((line) => line && (!q || line.toLowerCase().includes(q)))
    .slice(0, limit);

  return { ok: true, text: rows.join("\n") || "(no matching contacts)" };
}
