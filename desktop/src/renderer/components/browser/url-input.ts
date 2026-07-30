/**
 * What the address bar does with what you typed.
 *
 * The interesting case is the dev one. `localhost:3000` is not a URL — the
 * parser reads `localhost:` as the scheme — and prefixing it with https:// (the
 * safe default for a real host) sends you to a TLS handshake no dev server
 * answers. So local hosts get http:// and everything else gets https://.
 *
 * Dependency-free: this is where a typo becomes a search instead of a page, so
 * the rules are worth asserting directly.
 */

/** Schemes we hand to the page as-is. */
const SCHEME = /^(https?|file|about|data|chrome|devtools):/i;

/** localhost, 127.x, ::1, and *.localhost — the things that speak plain http. */
const LOCAL_HOST =
  /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|[a-z0-9-]+\.localhost)(:\d+)?$/i;

/** Something with a dot and no spaces — `example.com`, `sub.example.com:8080/x`. */
const HOSTISH = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i;

/** A bare host:port with no dot, e.g. `myserver:8080` on a corporate LAN. */
const HOST_PORT = /^[a-z0-9-]+:\d{2,5}([/?#].*)?$/i;

export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  if (SCHEME.test(raw)) return raw;

  const hostPart = raw.split(/[/?#]/)[0] ?? "";
  if (LOCAL_HOST.test(hostPart)) return `http://${raw}`;
  // `myserver:8080` — no dot, so not a public name; treat it as local-network
  // http rather than a search, which is what someone typing a port means.
  if (HOST_PORT.test(raw)) return `http://${raw}`;
  if (HOSTISH.test(raw)) return `https://${raw}`;

  // Not addressable — search for it. DuckDuckGo takes no account and sets no
  // profile cookie, so the panel stays as anonymous as it was.
  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
}

/** The bit of a URL worth showing when space is short (host, no scheme). */
export function displayHost(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return "file";
    if (u.protocol === "about:") return url;
    return u.host || u.protocol;
  } catch {
    return url;
  }
}
