/**
 * The shadow-repo rules a checkpoint depends on: what it refuses to snapshot,
 * how a session id becomes a directory name, and how git is told to pack.
 *
 * Dependency-free on purpose. Every claim here is about what GIT does with these
 * strings, so the probe has to be able to hand them to real git — and
 * checkpoints.ts reaches electron through data-dir. shared/brand is fine: it is
 * as pure as this file.
 */

import { DOT_DIR, DOT_DIR_PROD } from "@shared/brand.js";

/**
 * A session id as a directory name.
 *
 * The only copy: `sessions:delete` needs the same answer to remove a chat's
 * store, and two independent copies of this regex would eventually disagree —
 * deleting nothing, or deleting somebody else's.
 */
export function shadowSlug(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session";
}

/**
 * Let git pack these stores itself.
 *
 * Measured on a real data dir: 161 817 loose objects across 78 shadow repos,
 * 915 MB, and NOT ONE of them packed. git's auto-gc never fired, because its
 * threshold is 6 700 loose objects per repository and the busiest of these held
 * 3 600 — a per-chat repo never grows enough on its own, so they stay loose for
 * ever.
 *
 * Packing one measured 14.6 MB in 3 626 files down to 12.4 MB in 30. The size is
 * a sixth off; the file COUNT is the point — 161 817 tiny files is what a backup
 * tool or a virus scanner walks every time.
 *
 * Detached, so a snapshot never waits for it.
 */
export const PACK_CONFIG = ["[gc]", "\tauto = 400", "\tautoDetach = true", ""].join(
  "\n",
);

/** Has this store been told to pack yet? Cheap and idempotent. */
export function needsPackConfig(currentConfig: string): boolean {
  return !currentConfig.includes("auto = 400");
}

/** The config file's new contents, with the packing settings appended. */
export function withPackConfig(currentConfig: string): string {
  return `${currentConfig.trimEnd()}\n${PACK_CONFIG}`;
}

/**
 * Repo-local ignore patterns for the shadow repo (written to info/exclude).
 * The workspace's own .gitignore is still honoured on top of this; this is a
 * safety net so a workspace WITHOUT a .gitignore doesn't snapshot heavy dirs.
 * `.git/` is always excluded so we never vacuum the user's real repo internals.
 *
 * The build-directory list below was written for a project workspace. Measured on
 * a real data dir, it is not enough: 4.7 GB of 5.6 GB of all checkpoint storage
 * was ONE session whose workspace was `D:/alexivanov/Downloads` — a 602 MB LM
 * Studio installer, a 417 MB zip, a 206 MB installer, a 170 MB PDF — snapshotted
 * because Downloads has no .gitignore and none of these patterns matched.
 *
 * So: archives, installers and media too. Nothing here is something the agent
 * edits, which is what a checkpoint exists to undo. And the app's own data
 * directory, because a workspace at the repository root would otherwise snapshot
 * the checkpoint store into a checkpoint.
 */
export const DEFAULT_EXCLUDES = [
  ".git/",
  // Ours. A checkpoint of the checkpoints is the one that grows without bound.
  `${DOT_DIR}/`,
  `${DOT_DIR_PROD}/`,
  "node_modules/",
  "bower_components/",
  ".pnpm-store/",
  "dist/",
  "build/",
  "out/",
  "target/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".parcel-cache/",
  ".cache/",
  "coverage/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".mypy_cache/",
  ".pytest_cache/",
  ".gradle/",
  ".idea/",
  ".DS_Store",
  "*.log",
  // Installers and disk images.
  "*.exe",
  "*.msi",
  "*.dmg",
  "*.pkg",
  "*.deb",
  "*.rpm",
  "*.AppImage",
  "*.iso",
  "*.vmdk",
  "*.vdi",
  // Archives.
  "*.zip",
  "*.7z",
  "*.rar",
  "*.tar",
  "*.tgz",
  "*.gz",
  "*.xz",
  "*.bz2",
  "*.zst",
  // Media and large binary documents — not things the agent edits, and one of
  // them was 602 MB.
  "*.mp4",
  "*.mov",
  "*.mkv",
  "*.avi",
  "*.webm",
  "*.wav",
  "*.flac",
  "*.psd",
  "*.ai",
  "*.sketch",
  "*.blend",
  "",
].join("\n");
