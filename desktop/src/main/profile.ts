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

export interface Profile {
  name: string;
  about: string;
}

export function getProfile(): Profile {
  try {
    const j = JSON.parse(readFileSync(profileFile(), "utf-8")) as Partial<Profile>;
    return { name: j.name ?? "", about: j.about ?? "" };
  } catch {
    return { name: "", about: "" };
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
  const res = await fetch(
    `https://api.github.com/repos/${GALLERY_REPO}/git/trees/HEAD?recursive=1`,
    { headers: { "User-Agent": "monet-desktop", Accept: "application/vnd.github+json" } },
  );
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const json = (await res.json()) as { tree?: { path: string; type: string }[] };
  const imgs = (json.tree ?? [])
    .filter((e) => e.type === "blob" && /\.(png|jpe?g|webp)$/i.test(e.path))
    .slice(0, 18);
  const out: { url: string; dataUrl: string }[] = [];
  await Promise.allSettled(
    imgs.map(async (e) => {
      const url = `https://raw.githubusercontent.com/${GALLERY_REPO}/HEAD/${e.path}`;
      const r = await fetch(url, { headers: { "User-Agent": "monet-desktop" } });
      if (!r.ok) return;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 2 * 1024 * 1024) return;
      const mime = /\.png$/i.test(e.path)
        ? "image/png"
        : /\.webp$/i.test(e.path)
          ? "image/webp"
          : "image/jpeg";
      out.push({ url, dataUrl: `data:${mime};base64,${buf.toString("base64")}` });
    }),
  );
  galleryCache = out;
  return out;
}

/** System-prompt block, or null when the profile is empty. */
export function getProfilePrompt(): string | null {
  const p = getProfile();
  if (!p.name && !p.about) return null;
  const lines = ["# User profile"];
  if (p.name) lines.push(`The user's name: ${p.name}. Address them by name.`);
  if (p.about) lines.push(`About the user (their own words):\n${p.about.slice(0, 2_000)}`);
  return lines.join("\n");
}
