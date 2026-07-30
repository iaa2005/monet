/**
 * Extra audit rules, published by the repo rather than compiled in.
 *
 * "Всё, что может меняться, переносится в репо" — and audit patterns are the
 * most change-prone thing in the feature: a new `curl | bash` variant, a new
 * exfiltration trick, and today that means an app release.
 *
 * The built-in rules in skill-audit.ts are the floor. They always run, work
 * offline, and are the ones the probe holds to a measured false-positive rate.
 * These are added on top. Nothing here can weaken the built-ins — the file has
 * no way to disable a rule, only to add one, so a bad catalogue makes the audit
 * noisier at worst, never blinder.
 *
 * Rules are LITERALS, not patterns, and that is not a simplification for its own
 * sake: a JavaScript regex cannot be interrupted once it starts, so a hostile
 * pattern from this file would freeze the app with no way to time it out.
 * Measured before the design changed — `^(?:[a-z]|[a-z][a-z])+z$` against forty
 * characters spent 15 seconds inside one exec. Sixty literal rules over five
 * thousand long lines take 90 ms.
 */

import { parseAuditRules } from "./skill-audit.js";
import { fetchRetry } from "./net-fetch.js";

const RULES_URL =
  "https://raw.githubusercontent.com/iaa2005/monet-directory/main/skill-audit-rules.json";

/** An hour: new attack patterns are not a per-click concern. */
const CACHE_MS = 60 * 60 * 1000;

type Parsed = ReturnType<typeof parseAuditRules>;

let cache: { at: number; parsed: Parsed } | null = null;

export async function fetchAuditRules(force = false): Promise<Parsed> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.parsed;
  try {
    const res = await fetchRetry(RULES_URL, {
      headers: { "User-Agent": "monet-desktop" },
    });
    if (!res.ok) throw new Error(String(res.status));
    const parsed = parseAuditRules(await res.json());
    if (parsed.rejected.length)
      // Said out loud rather than dropped in silence: a rule that never compiles
      // is a rule someone believes is protecting them.
      console.warn(
        `[audit] ignored ${parsed.rejected.length} catalogue rule(s): ${parsed.rejected.join("; ")}`,
      );
    cache = { at: Date.now(), parsed };
    return parsed;
  } catch {
    // No file is the normal state — it may not exist yet, and the audit is not
    // allowed to depend on the network. Stale beats nothing; nothing beats
    // failing the preview.
    return cache?.parsed ?? { rules: [], rejected: [] };
  }
}
