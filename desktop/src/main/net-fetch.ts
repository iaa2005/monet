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

/** GH raw → jsDelivr mirror (often reachable when raw is blocked, and back). */
function mirrorOf(url: string): string | null {
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/[^/]+\/(.+)$/.exec(url);
  return m ? `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@HEAD/${m[3]}` : null;
}

export async function fetchRetry(url: string, init: Init = {}): Promise<Response> {
  const { timeoutMs = 15_000, tries = 2, noMirror = false, ...rest } = init;
  const mirror = noMirror ? null : mirrorOf(url);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      // Race primary vs mirror — whichever responds first wins.
      // With VPN: mirror (jsDelivr) is fast; without VPN: primary (GitHub) is fast.
      // No need to wait for the slow one.
      const urls = mirror ? [url, mirror] : [url];
      const res = await Promise.race(urls.map((u) => once(u, rest, timeoutMs)));
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
