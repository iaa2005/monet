/**
 * Making GitHub's 60-an-hour limit stop being the Directory's problem.
 *
 * Reported, with feeling: "GitHub rate limit reached — it resets in 19 minutes.
 * ну это издевательство! и что? я должен ждать столько?" No. Unauthenticated
 * `api.github.com` allows 60 requests an hour, and browsing a directory of
 * skills spends them on listing repositories. Three layers, cheapest first:
 *
 *   1. THE USER'S OWN TOKEN. If the GitHub connector is set up, that personal
 *      access token raises the same limit to 5 000 an hour. Nothing to configure
 *      twice — it is already stored, encrypted, for the MCP server.
 *
 *   2. A CACHE THAT SURVIVES RESTART. The tree cache lived in memory with a
 *      ten-minute life, so every restart re-spent the budget from zero — and
 *      during development that is many restarts an hour. On disk it costs one
 *      request per repository per day.
 *
 *   3. A PATH THE LIMIT DOES NOT TOUCH. Measured while the API was returning
 *      403 with zero remaining: `codeload.github.com/<repo>/tar.gz/HEAD`
 *      answered 200 for every repository tried, and the quota did not move —
 *      still 60 of 60 used. So a rate-limited listing is slow, not blocked.
 *
 * The archive is one request for the whole repository (0.8 MB for
 * vercel-labs/agent-skills, 15 MB for pbakaus/impeccable, which ships assets),
 * so it is a fallback rather than the normal path.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { gunzipSync } from "fflate";
import { getDataDir } from "../data-dir.js";

/** One request per repository per day, rather than per ten minutes per launch. */
const TREE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedTree {
  at: number;
  paths: string[];
}

let disk: Record<string, CachedTree> | null = null;

function cacheFile(): string {
  return join(getDataDir(), "github-trees.json");
}

function readCache(): Record<string, CachedTree> {
  if (disk) return disk;
  try {
    const raw = JSON.parse(readFileSync(cacheFile(), "utf-8")) as unknown;
    disk = raw && typeof raw === "object" ? (raw as Record<string, CachedTree>) : {};
  } catch {
    disk = {};
  }
  return disk;
}

export function cachedTree(repo: string): string[] | null {
  const hit = readCache()[repo];
  return hit && Date.now() - hit.at < TREE_TTL_MS ? hit.paths : null;
}

export function cacheTree(repo: string, paths: string[]): void {
  const all = readCache();
  all[repo] = { at: Date.now(), paths };
  // Bounded: 400 repositories of paths is a few megabytes, and the oldest
  // entries are the ones least likely to be asked for again.
  const keys = Object.keys(all);
  if (keys.length > 400)
    for (const k of keys.sort((a, b) => all[a]!.at - all[b]!.at).slice(0, keys.length - 400))
      delete all[k];
  try {
    writeFileSync(cacheFile(), JSON.stringify(all), "utf-8");
  } catch {
    // An unwritable cache is a slow app, not a broken one.
  }
}

/**
 * The user's GitHub token, if they have connected the GitHub connector.
 *
 * Read lazily and never cached across calls: the user can add or remove the
 * account while the app is running, and a stale token would send a 401 in place
 * of a working anonymous request.
 */
export async function githubToken(): Promise<string | null> {
  try {
    const store = await import("../connectors/store.js");
    const account = store
      .listAccounts()
      .find((a) => a.presetId === "github" && a.enabled);
    if (!account) return null;
    const secret = store.getSecret(account.id) as { password?: unknown };
    const token = typeof secret.password === "string" ? secret.password.trim() : "";
    return token || null;
  } catch {
    // No connector store, no token. The anonymous path still works.
    return null;
  }
}

/** Headers for an api.github.com call, authenticated when we can be. */
export async function githubHeaders(
  base: Record<string, string>,
): Promise<Record<string, string>> {
  const token = await githubToken();
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

// ── The path the limit does not touch ────────────────────────────────────────

/** A tar entry header is 512 bytes; the name is the first 100 of them. */
const BLOCK = 512;

/**
 * File paths inside a gzipped tar, with the archive's own top folder stripped.
 *
 * GitHub wraps everything in `<repo>-<sha>/`, which is not part of any path the
 * rest of the app knows about.
 */
export function tarPaths(gz: Uint8Array): string[] {
  const buf = gunzipSync(gz);
  const out: string[] = [];
  const dec = new TextDecoder();
  const str = (from: number, len: number): string =>
    dec.decode(buf.subarray(from, from + len)).replace(/\0.*$/, "");
  /** Set by a GNU ././@LongLink entry, and consumed by the entry after it. */
  let pending = "";
  for (let off = 0; off + BLOCK <= buf.length; ) {
    let name = str(off, 100);
    if (!name) {
      // Two zero blocks end the archive; one may be padding.
      off += BLOCK;
      continue;
    }
    const size = parseInt(str(off + 124, 12).trim(), 8) || 0;
    const type = String.fromCharCode(buf[off + 156] ?? 0);
    const body = off + BLOCK;
    // A name over 100 bytes does not fit the field. Both escapes matter, and
    // ignoring either returns a TRUNCATED path — worse than an error, because a
    // truncated path silently resolves a skill to the wrong folder.
    //
    //   ustar splits it across `prefix` (offset 345) and `name`;
    //   GNU writes the whole thing as the body of an 'L' entry first.
    const prefix = str(off + 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    if (type === "L") {
      pending = str(body, size).replace(/\0.*$/, "");
      off = body + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    if (pending) {
      name = pending;
      pending = "";
    }
    // '0' and '\0' are regular files; directories ('5'), PAX records ('x', 'g')
    // and the rest are not paths the skill store can read.
    if (type === "0" || type === "\0") out.push(name);
    off = body + Math.ceil(size / BLOCK) * BLOCK;
  }
  const root = out[0]?.split("/")[0] ?? "";
  return out
    .map((p) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p))
    .filter(Boolean);
}

/** Thrown by `treeViaArchive` when the repository itself is not there. */
export const MISSING = "monet:repo-missing";

/**
 * Every file in a repository, without spending API budget.
 *
 * Measured with the API returning 403 and 0 remaining: this answered 200 and the
 * quota stayed where it was.
 */
export async function treeViaArchive(repo: string): Promise<string[]> {
  const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/HEAD`, {
    headers: { "User-Agent": "monet-desktop" },
  });
  // A 404 here is worth telling apart. With no API budget the API answers 403
  // for everything, including repositories that do not exist — so without this
  // a typo in a source reads as "rate limit reached", which sends the user off
  // to wait for a reset that will not help.
  if (res.status === 404) throw new Error(MISSING);
  if (!res.ok) throw new Error(`Could not read ${repo} (archive ${res.status}).`);
  return tarPaths(new Uint8Array(await res.arrayBuffer()));
}
