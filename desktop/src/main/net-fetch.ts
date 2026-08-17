/**
 * VPN/proxy-friendly fetch for the main process.
 *
 * Node's global fetch (undici) bypasses the system proxy stack, so requests
 * that work in the browser "fetch failed" under VPNs. Electron's net.fetch
 * rides Chromium's network stack (system proxy, VPN, PAC) — prefer it, fall
 * back to global fetch (smoke harness / tests). Adds timeout + retries, and a
 * jsDelivr mirror fallback for raw.githubusercontent.com content.
 */

import { net } from "electron";

type Init = RequestInit & { timeoutMs?: number; tries?: number; noMirror?: boolean };

async function once(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const doFetch =
      typeof (net as { fetch?: typeof fetch } | undefined)?.fetch === "function"
        ? (net.fetch.bind(net) as typeof fetch)
        : fetch;
    return await doFetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GH raw → jsDelivr mirror (often reachable when raw is blocked, and back).
 *
 * The ref is carried across rather than pinned to @HEAD: jsDelivr resolves a
 * branch, a tag or a commit, and "HEAD" is none of those — every mirrored URL
 * used to 404 there, which is a fallback that never fell back. With no @ref at
 * all jsDelivr serves the default branch, which is what HEAD means.
 */
function mirrorOf(url: string): string | null {
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url);
  if (!m) return null;
  const ref = m[3] === "HEAD" ? "" : `@${m[3]}`;
  return `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}${ref}/${m[4]}`;
}

/**
 * First SUCCESS wins — not first to settle.
 *
 * `Promise.race` hands back whatever finishes first, including a rejection:
 * one unreachable mirror (jsDelivr times out or DNS-fails on some networks —
 * measured here at 25 s and nothing) would then decide the request while the
 * primary was busy answering perfectly well. So a failure only counts once
 * every candidate has failed, and what comes back then is the last real
 * response — the caller wants to see GitHub's 429, not a mirror's DNS error.
 */
async function firstSuccess(
  urls: string[],
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (urls.length === 1) return once(urls[0]!, init, timeoutMs);
  return new Promise<Response>((resolve, reject) => {
    let left = urls.length;
    let lastRes: Response | null = null;
    let lastErr: unknown = null;
    for (const u of urls)
      once(u, init, timeoutMs).then(
        (res) => {
          if (res.ok) return resolve(res);
          lastRes = res;
          if (--left === 0) resolve(res);
        },
        (err) => {
          lastErr = err;
          if (--left === 0)
            lastRes
              ? resolve(lastRes)
              : reject(lastErr instanceof Error ? lastErr : new Error("fetch failed"));
        },
      );
  });
}

export async function fetchRetry(url: string, init: Init = {}): Promise<Response> {
  const { timeoutMs = 15_000, tries = 2, noMirror = false, ...rest } = init;
  const mirror = noMirror ? null : mirrorOf(url);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      // Primary and mirror together: with a VPN jsDelivr is the fast one,
      // without it GitHub is, and neither has to wait for the other.
      const urls = mirror ? [url, mirror] : [url];
      const res = await firstSuccess(urls, rest, timeoutMs);
      // 429 is deliberately NOT retried. It is GitHub telling this machine it
      // has asked for too much, and the cure for that is fewer requests (see
      // the gallery's disk cache), not the same request again 200 ms later.
      // Retry transient upstream errors; return everything else as-is.
      if (![502, 503, 504].includes(res.status)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error("fetch failed");
}
