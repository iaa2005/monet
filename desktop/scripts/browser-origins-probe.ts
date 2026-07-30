/**
 * The allowlist.
 *
 * An allowlist that is wrong in the permissive direction is a security bug;
 * wrong in the strict direction it is an app that asks about localhost forty
 * times an hour. Both mistakes are one character away from the right answer,
 * so the rules are asserted rather than reviewed:
 *
 *  - `example.com` must never cover `evil.example.com`. That is the whole
 *    point of an origin list, and a naive endsWith() gets it exactly wrong.
 *  - A pattern with no port means the DEFAULT port. `https://acme.dev` covering
 *    `https://acme.dev:8443` would let anything behind an unusual port through.
 *  - Scheme is part of the origin: an https allowance is not an http one.
 *  - localhost is allowed at ANY port without being listed, because a dev
 *    server moving from 3000 to 3001 is not a change in trust.
 */

import {
  isLocalOrigin,
  isOriginAllowed,
  isValidPattern,
  matchesPattern,
  originLabel,
  parseOrigin,
} from "../src/shared/origins";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

// ── 1. localhost is free, at any port, without being listed ───────────
{
  for (const url of [
    "http://localhost:3000/x",
    "http://localhost:5173",
    "http://127.0.0.1:8080/a?b=1",
    "http://[::1]:4321/",
    "https://localhost:8443/",
    "http://localhost:17173/docs",
  ]) {
    check(`built-in: ${url}`, isOriginAllowed(url, []), url);
  }
  check("file:// is built in", isOriginAllowed("file:///C:/tmp/a.html", []));
  check("isLocalOrigin agrees", isLocalOrigin("http://localhost:3000"));
  check("a public host is not local", !isLocalOrigin("https://example.com"));
}

// ── 2. Nothing else is allowed by default ─────────────────────────────
{
  for (const url of [
    "https://example.com",
    "http://192.168.1.10:8080",
    "https://internal.corp",
    "https://localhost.evil.com",
  ]) {
    check(`denied by default: ${url}`, !isOriginAllowed(url, []), url);
  }
}

// ── 3. A subdomain is not the domain ──────────────────────────────────
{
  const list = ["https://example.com"];
  check("the exact host matches", isOriginAllowed("https://example.com/a", list));
  check(
    "a subdomain does NOT match",
    !isOriginAllowed("https://evil.example.com", list),
  );
  check(
    "a lookalike suffix does NOT match",
    !isOriginAllowed("https://notexample.com", list),
  );
  check(
    "the domain as a prefix does NOT match",
    !isOriginAllowed("https://example.com.evil.net", list),
  );
}

// ── 4. `*.` opts into subdomains, and covers the apex ─────────────────
{
  const list = ["https://*.example.com"];
  check("a subdomain matches", isOriginAllowed("https://api.example.com", list));
  check("a deep subdomain matches", isOriginAllowed("https://a.b.example.com", list));
  check("the apex matches too", isOriginAllowed("https://example.com", list));
  check(
    "a different domain still does not",
    !isOriginAllowed("https://example.com.evil.net", list),
  );
}

// ── 5. Ports are part of the origin ───────────────────────────────────
{
  check(
    "no port in the pattern means the default port",
    isOriginAllowed("https://acme.dev/path", ["https://acme.dev"]),
  );
  check(
    "a non-default port is NOT covered by a portless pattern",
    !isOriginAllowed("https://acme.dev:8443/", ["https://acme.dev"]),
  );
  check(
    "an explicit port matches",
    isOriginAllowed("http://build.local:8080/", ["http://build.local:8080"]),
  );
  check(
    "the wrong port does not",
    !isOriginAllowed("http://build.local:9090/", ["http://build.local:8080"]),
  );
  check(
    ":* opts into any port",
    isOriginAllowed("https://acme.dev:8443/", ["https://acme.dev:*"]),
  );
  check(
    "an explicit default port matches a portless pattern",
    isOriginAllowed("https://acme.dev:443/", ["https://acme.dev"]),
  );
}

// ── 6. Schemes are part of the origin ─────────────────────────────────
{
  check(
    "https allowance is not an http one",
    !isOriginAllowed("http://acme.dev", ["https://acme.dev"]),
  );
  check(
    "*:// takes either",
    isOriginAllowed("http://acme.dev", ["*://acme.dev"]) &&
      isOriginAllowed("https://acme.dev", ["*://acme.dev"]),
  );
}

// ── 7. `*` is the escape hatch, and only when written alone ───────────
{
  check("* allows anything", isOriginAllowed("https://anything.example", ["*"]));
  check(
    "a junk pattern allows nothing",
    !isOriginAllowed("https://example.com", ["not a pattern", "", "  "]),
  );
  check(
    "a bare hostname is not a pattern",
    !isOriginAllowed("https://example.com", ["example.com"]),
  );
}

// ── 8. Junk URLs are refused, not guessed at ──────────────────────────
{
  check("not a URL is not allowed", !isOriginAllowed("javascript:alert(1)", ["*://*"]));
  check("an empty URL matches no real pattern", !isOriginAllowed("", ["https://acme.dev"]));
  check(
    "a data: URL is not an origin",
    !isOriginAllowed("data:text/html,<h1>hi", ["https://acme.dev"]),
  );
  check("parseOrigin rejects junk", parseOrigin("nonsense") === null);
  check(
    "parseOrigin lowercases the host",
    parseOrigin("https://EXAMPLE.com/X")?.host === "example.com",
  );
  check(
    "parseOrigin fills the default port",
    parseOrigin("https://example.com")?.port === "443",
  );
}

// ── 9. Labels are for humans ──────────────────────────────────────────
{
  check(
    "the default port is not shown",
    originLabel("https://example.com/a/b") === "https://example.com",
    originLabel("https://example.com/a/b"),
  );
  check(
    "a real port is shown",
    originLabel("http://localhost:3000/x") === "http://localhost:3000",
    originLabel("http://localhost:3000/x"),
  );
}

// ── 10. The settings field rejects nonsense before it is saved ────────
{
  check("* is valid", isValidPattern("*"));
  check("https://example.com is valid", isValidPattern("https://example.com"));
  check("https://*.example.com is valid", isValidPattern("https://*.example.com"));
  check("http://localhost:3000 is valid", isValidPattern("http://localhost:3000"));
  check("a trailing slash is tolerated", isValidPattern("https://example.com/"));
  check("a bare host is not valid", !isValidPattern("example.com"));
  check("a path is not valid", !isValidPattern("https://example.com/admin"));
  check("empty is not valid", !isValidPattern("   "));
}

// ── 11. One bad entry does not poison the list ────────────────────────
{
  const list = ["oops", "https://acme.dev", "also bad"];
  check("the good entry still works", isOriginAllowed("https://acme.dev", list));
  check("the bad ones allow nothing", !isOriginAllowed("https://oops", list));
}

console.log(failures === 0 ? "\nbrowser origins probe OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
