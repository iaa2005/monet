/**
 * The avatar gallery asks GitHub once, not once per look.
 *
 * Reported as "GitHub raw returned 429/429" when opening the avatar picker.
 * It was earned honestly: two manifests on every open and a whole painting on
 * every arrow key, straight from raw.githubusercontent, with nothing kept
 * between sessions — out of a 630 MB repository. GitHub rate-limits raw per
 * IP, so browsing the gallery twice was enough to lock the feature until the
 * limit expired, and the error told the user nothing they could act on.
 *
 * What is pinned here:
 *   - a file fetched once is not fetched again (that is the whole fix);
 *   - a manifest older than its day refreshes, and when the refresh fails the
 *     STALE copy is served rather than an error;
 *   - with nothing cached and a 429, the message names the rate limit;
 *   - the jsDelivr mirror is a real URL (it used to be pinned to @HEAD, which
 *     jsDelivr cannot resolve — a fallback that always 404'd);
 *   - one unreachable mirror cannot lose the race for a healthy primary.
 *
 *   npm run smoke:gallery
 */

import { mkdtempSync, rmSync, utimesSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dataDir = mkdtempSync(join(tmpdir(), "monet-gallery-"));
process.env.MONET_DATA_DIR = dataDir;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}`);
    if (detail !== undefined) console.log("      ", JSON.stringify(detail));
  }
}

// ── the network, under our thumb ──────────────────────────────────────────
const calls: string[] = [];
let respond: (url: string) => Response = () => new Response("", { status: 500 });
globalThis.fetch = ((url: string | URL | Request, _init?: RequestInit) => {
  const u = typeof url === "string" ? url : url.toString();
  calls.push(u);
  return Promise.resolve(respond(u));
}) as typeof fetch;

const PAINTINGS = JSON.stringify([
  { title: "Water Lilies", year: "1906", filename: "artworks/lilies.jpg", width: 100, height: 80 },
]);
const AVATARS = JSON.stringify([
  { filename: "face.jpg", source: "artworks/lilies.jpg", bbox: { x: 1, y: 2, w: 3, h: 4 } },
]);

const ok = (body: string): Response => new Response(body, { status: 200 });
respond = (u) =>
  u.includes("monet_paintings.json")
    ? ok(PAINTINGS)
    : u.includes("avatars.json")
      ? ok(AVATARS)
      : u.includes("artworks/")
        ? ok("JPEGBYTES")
        : new Response("", { status: 404 });

const profile = await import("../src/main/app/profile.js");

// ── 1. the fix itself: ask once ───────────────────────────────────────────
const first = await profile.listPaintings();
check("the picker reads the gallery", first.length === 1 && first[0]!.faces.length === 1, first);
const afterFirst = calls.length;
// Two manifests, each asked of GitHub and of the mirror at once — the mirror
// is a different CDN and costs nothing against the raw limit that broke this.
check(
  "…over the network the first time, once per file per host",
  calls.filter((u) => u.includes("raw.githubusercontent")).length === 2 &&
    calls.some((u) => u.includes("jsdelivr")),
  { calls: calls.slice() },
);

await profile.listPaintings();
check("…and from disk the second time", calls.length === afterFirst, {
  extra: calls.slice(afterFirst),
});

const img = await profile.paintingImage("artworks/lilies.jpg");
check("a painting downloads once", img.startsWith("data:image/jpeg;base64,"));
const afterImg = calls.length;
await profile.paintingImage("artworks/lilies.jpg");
check("…and is never downloaded again", calls.length === afterImg);
check(
  "the cache is on disk, in the data dir",
  existsSync(join(dataDir, "gallery")) &&
    readdirSync(join(dataDir, "gallery")).length >= 3,
  readdirSync(join(dataDir, "gallery")),
);

// ── 2. stale beats an error ───────────────────────────────────────────────
// Age the manifests past their day, then answer every request with the 429
// that started all this.
const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
for (const f of readdirSync(join(dataDir, "gallery")))
  utimesSync(join(dataDir, "gallery", f), twoDaysAgo, twoDaysAgo);
respond = () => new Response("429: Too Many Requests", { status: 429 });

const stale = await profile.listPaintings();
check("a manifest past its day is refreshed", calls.length > afterImg);
check("…and when the refresh 429s, yesterday's copy is served", stale.length === 1, stale);

// ── 3. nothing cached, and GitHub says no ─────────────────────────────────
rmSync(join(dataDir, "gallery"), { recursive: true, force: true });
let message = "";
try {
  await profile.listPaintings();
} catch (err) {
  message = err instanceof Error ? err.message : String(err);
}
check(
  "with an empty cache the 429 is explained, not printed",
  /rate-limit/i.test(message) && !/429\/429/.test(message),
  message,
);

// ── 4. the mirror is a URL jsDelivr can resolve ───────────────────────────
const net = await import("../src/main/net-fetch.js");
const seen: string[] = [];
respond = (u) => {
  seen.push(u);
  return u.includes("jsdelivr")
    ? new Response("", { status: 404 })
    : ok("primary");
};
calls.length = 0;
await net.fetchRetry("https://raw.githubusercontent.com/o/r/main/a/b.json");
check(
  "a branch ref reaches jsDelivr as @branch",
  seen.some((u) => u === "https://cdn.jsdelivr.net/gh/o/r@main/a/b.json"),
  seen.slice(),
);
seen.length = 0;
await net.fetchRetry("https://raw.githubusercontent.com/o/r/HEAD/a/b.json");
check(
  "…and HEAD as jsDelivr's own default branch, with no @ref",
  seen.some((u) => u === "https://cdn.jsdelivr.net/gh/o/r/a/b.json"),
  seen.slice(),
);

// ── 5. a dead mirror does not decide the request ──────────────────────────
respond = (u) => {
  if (u.includes("jsdelivr")) throw new Error("ENOTFOUND cdn.jsdelivr.net");
  return ok("primary");
};
const res = await net.fetchRetry("https://raw.githubusercontent.com/o/r/main/a/b.json");
check(
  "an unreachable mirror loses to a healthy primary",
  res.ok && (await res.text()) === "primary",
);

rmSync(dataDir, { recursive: true, force: true });
console.log(
  failures === 0
    ? "\nTHE GALLERY ASKS ONCE, AND REMEMBERS"
    : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
