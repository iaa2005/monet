/**
 * User profile — name, "about me" prompt and avatar. Name/about are injected
 * into the system prompt; the avatar can be uploaded or picked from the
 * user's Monet-faces gallery repo (github.com/iaa2005/monet-paintings).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import { fetchRetry } from "../net-fetch.js";

const GALLERY_REPO = "iaa2005/monet-paintings";
const profileFile = (): string => join(getDataDir(), "profile.json");
const avatarFile = (): string => join(getDataDir(), "avatar.png");

const GITHUB_FETCH: RequestInit = { headers: { "User-Agent": "monet-desktop" } };

/**
 * The gallery, on disk.
 *
 * GitHub rate-limits raw.githubusercontent per IP, and the picker used to ask
 * it for everything, every time: two manifests on open and a whole painting
 * (up to 6 MB, out of a 630 MB repo) on every arrow key, with nothing kept
 * between sessions. Browsing the gallery twice was enough to earn
 *   GitHub raw returned 429/429
 * and then the picker was simply broken until GitHub forgot about us.
 *
 * A file in a repository at a fixed path is a fixed picture, so an image is
 * cached forever and the manifests for a day. The cure for a rate limit is
 * fewer requests; retrying harder is how you keep one.
 */
const cacheDir = (): string => {
  const dir = join(getDataDir(), "gallery");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
};

const cachePath = (repoPath: string): string =>
  join(cacheDir(), repoPath.replace(/[^\w.-]+/g, "_"));

const DAY_MS = 24 * 60 * 60 * 1000;

function readCache(file: string): { buf: Buffer; ageMs: number } | null {
  try {
    if (!existsSync(file)) return null;
    return {
      buf: readFileSync(file),
      ageMs: Date.now() - statSync(file).mtimeMs,
    };
  } catch {
    return null;
  }
}

/** What to tell the user when the network says no and nothing is cached. */
function rawFailure(res: Response | null): string {
  if (!res)
    return "GitHub is unreachable from here — check the connection (or the VPN) and try again.";
  if (res.status === 429)
    return (
      "GitHub is rate-limiting downloads from this network (429). It clears " +
      "by itself in a few minutes; meanwhile you can upload your own image."
    );
  return `GitHub returned ${res.status}.`;
}

/**
 * A file from the gallery repo, through the cache.
 *
 * `ttlMs` omitted means "keep it forever". A stale copy is always preferred to
 * an error: when the refresh fails, the picker opens on yesterday's manifest
 * rather than on a red line.
 */
async function galleryFile(
  repoPath: string,
  opts: { ttlMs?: number; maxBytes: number },
): Promise<Buffer> {
  const file = cachePath(repoPath);
  const cached = readCache(file);
  if (cached && (opts.ttlMs === undefined || cached.ageMs < opts.ttlMs))
    return cached.buf;

  let res: Response | null = null;
  try {
    res = await fetchRetry(`${RAW}/${repoPath}`, {
      ...GITHUB_FETCH,
      timeoutMs: 20_000,
    });
  } catch {
    /* offline, blocked, timed out — the cache below is the answer */
  }
  if (res?.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > opts.maxBytes)
      throw new Error(`${repoPath} is larger than expected`);
    try {
      writeFileSync(file, buf);
    } catch {
      /* a cache that cannot be written still serves this call */
    }
    return buf;
  }
  if (cached) return cached.buf;
  throw new Error(rawFailure(res));
}

export interface Profile {
  name: string;
  about: string;
  fullName: string;
  work: string;
}

export function getProfile(): Profile {
  try {
    const j = JSON.parse(readFileSync(profileFile(), "utf-8")) as Partial<Profile>;
    return {
      name: j.name ?? "",
      about: j.about ?? "",
      fullName: j.fullName ?? "",
      work: j.work ?? "",
    };
  } catch {
    return { name: "", about: "", fullName: "", work: "" };
  }
}

export function setProfile(patch: Partial<Profile>): Profile {
  const next = { ...getProfile(), ...patch };
  writeFileSync(profileFile(), JSON.stringify(next, null, 2));
  return next;
}

export function avatarDataUrl(): string | null {
  try {
    if (!existsSync(avatarFile())) return null;
    return `data:image/png;base64,${readFileSync(avatarFile()).toString("base64")}`;
  } catch {
    return null;
  }
}

export function setAvatarFromFile(path: string): { ok: boolean; error?: string } {
  try {
    copyFileSync(path, avatarFile());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "copy failed" };
  }
}

/**
 * Gone with this change: a second avatar picker that listed the repo through
 * api.github.com and then downloaded every crop in it at once — an unused
 * screen (the paintings carousel replaced it) whose only remaining effect was
 * a burst of raw requests towards the rate limit that broke the picker that IS
 * used. Nothing in the renderer called it.
 */

/** System-prompt block, or null when the profile is empty. */
export function getProfilePrompt(): string | null {
  const p = getProfile();
  if (!p.name && !p.about && !p.fullName && !p.work) return null;
  const lines = ["# User profile"];
  if (p.name) lines.push(`Call the user "${p.name}".`);
  if (p.fullName) lines.push(`Full name: ${p.fullName}.`);
  if (p.work) lines.push(`Their work: ${p.work}.`);
  if (p.about) lines.push(`Instructions from the user (keep in mind across chats):\n${p.about.slice(0, 2_000)}`);
  return lines.join("\n");
}

// ── Monet paintings picker (full-screen gallery) ─────────────────────────

export interface PaintingFace {
  /** avatars/<file>.jpg (the 256×256 crop to install as the avatar). */
  file: string;
  bbox: { x: number; y: number; w: number; h: number };
}
export interface PaintingInfo {
  title: string;
  year: string;
  /** artworks/<file>.jpg */
  file: string;
  width: number;
  height: number;
  faces: PaintingFace[];
}

// The branch, not HEAD: jsDelivr — the mirror that carries this when raw is
// blocked or rate-limiting — resolves a branch and does not resolve "HEAD".
const RAW = `https://raw.githubusercontent.com/${GALLERY_REPO}/main`;

/** Paintings that contain detected faces, with bbox overlays for the picker. */
export async function listPaintings(): Promise<PaintingInfo[]> {
  const [pBuf, aBuf] = await Promise.all([
    galleryFile("monet_paintings.json", { ttlMs: DAY_MS, maxBytes: 4 * 1024 * 1024 }),
    galleryFile("avatars/avatars.json", { ttlMs: DAY_MS, maxBytes: 4 * 1024 * 1024 }),
  ]);
  const paintings = JSON.parse(pBuf.toString("utf-8")) as {
    title: string; year: string; filename: string; width: number; height: number;
  }[];
  const avatars = JSON.parse(aBuf.toString("utf-8")) as {
    filename: string; source: string;
    bbox: { x: number; y: number; w: number; h: number };
  }[];
  const bySource = new Map<string, PaintingFace[]>();
  for (const a of avatars) {
    const arr = bySource.get(a.source) ?? [];
    arr.push({ file: `avatars/${a.filename}`, bbox: a.bbox });
    bySource.set(a.source, arr);
  }
  const out: PaintingInfo[] = [];
  for (const p of paintings) {
    const faces = bySource.get(p.filename);
    if (!faces?.length) continue;
    out.push({
      title: p.title, year: p.year, file: p.filename,
      width: p.width, height: p.height, faces,
    });
  }
  return out;
}

export async function paintingImage(file: string): Promise<string> {
  if (!/^artworks\/[\w.-]+\.(jpe?g|png|webp)$/i.test(file))
    throw new Error("Invalid painting path");
  // No TTL: this path in this repo is this painting, today and next month.
  // Arrowing back through the gallery costs nothing after the first pass.
  const buf = await galleryFile(file, { maxBytes: 6 * 1024 * 1024 });
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

/** Install one of the gallery's 256×256 crops as the avatar. */
export async function pickGalleryAvatar(
  file: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!/^avatars\/[\w.-]+\.(jpe?g|png|webp)$/i.test(file))
    return { ok: false, error: "Invalid avatar path" };
  try {
    // Through the same cache: the crop of the face you are looking at was
    // very often already fetched, and then choosing it touches no network.
    writeFileSync(avatarFile(), await galleryFile(file, { maxBytes: 4 * 1024 * 1024 }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "download failed" };
  }
}
