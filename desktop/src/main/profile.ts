/**
 * User profile — name, "about me" prompt and avatar. Name/about are injected
 * into the system prompt; the avatar can be uploaded or picked from the
 * user's Monet-faces gallery repo (github.com/iaa2005/monet-paintings).
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "./data-dir.js";

const GALLERY_REPO = "iaa2005/monet-paintings";
const profileFile = (): string => join(getDataDir(), "profile.json");
const avatarFile = (): string => join(getDataDir(), "avatar.png");

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "monet-desktop" },
    });
  } finally {
    clearTimeout(timer);
  }
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

export async function setAvatarFromUrl(
  url: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "monet-desktop" } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return { ok: false, error: "Image too large" };
    writeFileSync(avatarFile(), buf);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "download failed" };
  }
}

// Gallery previews are fetched once per app run (small data URLs).
let galleryCache: { url: string; dataUrl: string }[] | null = null;

export async function listGallery(): Promise<{ url: string; dataUrl: string }[]> {
  if (galleryCache) return galleryCache;

  // Fetch directory listing from GitHub API (15 s timeout).
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `https://api.github.com/repos/${GALLERY_REPO}/contents/avatars`,
      15_000,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    throw new Error(`GitHub API unreachable: ${msg}`);
  }
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);

  const json = (await res.json()) as { name: string; download_url: string; type: string }[];
  const imgs = (Array.isArray(json) ? json : [])
    .filter((e) => e.type === "file" && /\.(png|jpe?g|webp)$/i.test(e.name));

  // Download each avatar preview (10 s timeout per image).
  const out: { url: string; dataUrl: string }[] = [];
  await Promise.allSettled(
    imgs.map(async (e) => {
      let r: Response;
      try {
        r = await fetchWithTimeout(e.download_url, 10_000);
      } catch {
        return;
      }
      if (!r.ok) return;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 2 * 1024 * 1024) return;
      const mime = /\.png$/i.test(e.name)
        ? "image/png"
        : /\.webp$/i.test(e.name)
          ? "image/webp"
          : "image/jpeg";
      out.push({ url: e.download_url, dataUrl: `data:${mime};base64,${buf.toString("base64")}` });
    }),
  );

  // Only cache non-empty results so a transient failure isn't sticky.
  if (out.length > 0) galleryCache = out;
  return out;
}

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

const RAW = `https://raw.githubusercontent.com/${GALLERY_REPO}/HEAD`;
let paintingsCache: PaintingInfo[] | null = null;

/** Paintings that contain detected faces, with bbox overlays for the picker. */
export async function listPaintings(): Promise<PaintingInfo[]> {
  if (paintingsCache) return paintingsCache;
  const [pRes, aRes] = await Promise.all([
    fetchWithTimeout(`${RAW}/monet_paintings.json`, 15_000),
    fetchWithTimeout(`${RAW}/avatars/avatars.json`, 15_000),
  ]);
  if (!pRes.ok || !aRes.ok)
    throw new Error(`GitHub raw returned ${pRes.status}/${aRes.status}`);
  const paintings = (await pRes.json()) as {
    title: string; year: string; filename: string; width: number; height: number;
  }[];
  const avatars = (await aRes.json()) as {
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
  if (out.length > 0) paintingsCache = out;
  return out;
}

// Small LRU of painting images (compressed jpgs, a few hundred KB each).
const paintingImgCache = new Map<string, string>();

export async function paintingImage(file: string): Promise<string> {
  if (!/^artworks\/[\w.-]+\.(jpe?g|png|webp)$/i.test(file))
    throw new Error("Invalid painting path");
  const hit = paintingImgCache.get(file);
  if (hit) return hit;
  const res = await fetchWithTimeout(`${RAW}/${file}`, 20_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 6 * 1024 * 1024) throw new Error("Painting too large");
  const dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
  paintingImgCache.set(file, dataUrl);
  if (paintingImgCache.size > 6)
    paintingImgCache.delete(paintingImgCache.keys().next().value as string);
  return dataUrl;
}

/** Raw URL of an avatar crop (what setAvatarFromUrl downloads). */
export function avatarRawUrl(file: string): string {
  return `${RAW}/${file}`;
}
