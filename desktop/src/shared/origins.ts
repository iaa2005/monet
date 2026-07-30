/**
 * Which sites the agent may act on without asking.
 *
 * Shared, not main-only: the permission pipeline enforces these patterns and
 * the settings field validates what you type into it, and those two must agree
 * about what a pattern is. A bare hostname that the field accepts and the
 * matcher never matches reads as the allowlist being ignored.
 *
 * Dependency-free, because an allowlist that is wrong in the permissive
 * direction is a security bug and an allowlist that is wrong in the strict
 * direction is an app that asks about localhost forty times an hour.
 *
 * Two rules are worth stating outright, because both directions are plausible
 * and only one is safe:
 *
 *  - A pattern without a port means that scheme's DEFAULT port. `https://acme.dev`
 *    does not cover `https://acme.dev:8443`; write `https://acme.dev:*` if that
 *    is what you meant. Widening silently is how an allowlist stops meaning
 *    anything.
 *  - `example.com` never covers `evil.example.com`. A subdomain has to be asked
 *    for with `*.`, which — following Chrome's match patterns — also covers the
 *    apex, since that is what people expect it to.
 *
 * localhost is built in at any port. It is the user's own machine, and a dev
 * server that moves from 3000 to 3001 is not a change in trust.
 */

/** Always allowed: the user's own machine, and local files. */
const BUILT_IN = [
  "http://localhost:*",
  "https://localhost:*",
  "http://127.0.0.1:*",
  "https://127.0.0.1:*",
  "http://[::1]:*",
  "https://[::1]:*",
  "http://0.0.0.0:*",
  "file://",
];

const DEFAULT_PORT: Record<string, string> = { http: "80", https: "443" };

interface ParsedOrigin {
  scheme: string;
  host: string;
  port: string;
}

/** The origin of a URL, normalised, or null when it isn't one. */
export function parseOrigin(url: string): ParsedOrigin | null {
  try {
    const u = new URL(url);
    const scheme = u.protocol.replace(/:$/, "").toLowerCase();
    if (scheme === "file") return { scheme, host: "", port: "" };
    if (!u.hostname) return null;
    return {
      scheme,
      host: u.hostname.toLowerCase(),
      port: u.port || DEFAULT_PORT[scheme] || "",
    };
  } catch {
    return null;
  }
}

/** Human-readable origin, for the settings list and the permission prompt. */
export function originLabel(url: string): string {
  const o = parseOrigin(url);
  if (!o) return url;
  if (o.scheme === "file") return "file://";
  const shownPort = o.port && o.port !== DEFAULT_PORT[o.scheme] ? `:${o.port}` : "";
  return `${o.scheme}://${o.host}${shownPort}`;
}

const PATTERN =
  /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*\.[^/:]+|\[[^\]]+\]|[^/:]+)?(?::(\d+|\*))?\/?$/i;

/**
 * Does this URL match one allowlist pattern?
 *
 * Accepted shapes: `*`, `https://example.com`, `https://*.example.com`,
 * `http://localhost:3000`, `https://acme.dev:*`, `*://example.com`, `file://`.
 */
export function matchesPattern(url: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p === "*") return true;

  const target = parseOrigin(url);
  if (!target) return false;

  const m = PATTERN.exec(p);
  if (!m) return false;
  const [, scheme, rawHost, rawPort] = m;

  if (scheme !== "*" && scheme!.toLowerCase() !== target.scheme) return false;

  // `file://` has no host — the scheme match is the whole test.
  if (target.scheme === "file") return true;

  const host = (rawHost ?? "").toLowerCase();
  if (!host) return false;
  if (host.startsWith("*.")) {
    const bare = host.slice(2);
    // Chrome's rule: `*.example.com` covers example.com too. Anything else
    // surprises people into adding both lines.
    if (target.host !== bare && !target.host.endsWith(`.${bare}`)) return false;
  } else if (host !== target.host) {
    return false;
  }

  const port = rawPort ?? DEFAULT_PORT[target.scheme] ?? "";
  if (port === "*") return true;
  return port === target.port;
}

/** Is this URL on the allowlist (user patterns plus the built-in local ones)? */
export function isOriginAllowed(url: string, patterns: readonly string[]): boolean {
  for (const p of BUILT_IN) if (matchesPattern(url, p)) return true;
  for (const p of patterns) if (matchesPattern(url, p)) return true;
  return false;
}

/** True for the local addresses that are always allowed. */
export function isLocalOrigin(url: string): boolean {
  return BUILT_IN.some((p) => matchesPattern(url, p));
}

/** Reject nonsense before it reaches the settings list. */
export function isValidPattern(pattern: string): boolean {
  const p = pattern.trim();
  return p === "*" || PATTERN.test(p);
}
