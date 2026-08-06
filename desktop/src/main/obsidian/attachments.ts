/**
 * Files that are not notes: images, video, PDFs — everything a vault holds
 * beside its Markdown.
 *
 * Two questions, both answered the way Obsidian answers them:
 *
 * WHERE DOES IT GO. Obsidian keeps the answer in the vault, not in this app:
 * `.obsidian/app.json` carries `attachmentFolderPath`, which may be a plain
 * folder ("attachments"), the vault root (""), or a per-note subfolder
 * ("./assets", relative to the note being edited). We honour the first two
 * literally and read the third as "beside the note" — the same placement
 * Obsidian would make — so files land where the user's own vault already
 * puts them instead of in a folder this app invented.
 *
 * HOW IS IT REFERENCED. `![[name.png]]` — an embed, the form Obsidian
 * renders inline. The name alone is enough: Obsidian resolves attachments
 * by basename the same way it resolves notes, which is why the app can copy
 * a file into any folder and still write a link that works.
 *
 * A vault is often a cloud-sync folder, so the copy is atomic (tmp + rename)
 * and a name that already exists gets a suffix rather than clobbering
 * somebody's picture.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "fs";
import { dirname, join } from "path";
import type { VaultConfig } from "./vaults.js";

/** Attachment kinds Obsidian renders inline; the rest are plain links. */
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const VIDEO = /\.(mp4|webm|mov|mkv|ogv)$/i;
const AUDIO = /\.(mp3|wav|ogg|m4a|flac)$/i;

export type AttachmentKind = "image" | "video" | "audio" | "file";

export function attachmentKind(name: string): AttachmentKind {
  if (IMAGE.test(name)) return "image";
  if (VIDEO.test(name)) return "video";
  if (AUDIO.test(name)) return "audio";
  return "file";
}

/** Is this a file the vault index should ignore? (Everything not a note.) */
export function isAttachmentFile(name: string): boolean {
  return !/\.(md|canvas|base)$/i.test(name);
}

/**
 * The vault's own attachment folder, as a vault-relative path.
 *
 * `noteRelPath` matters only for the per-note form ("./assets"), where
 * Obsidian places the file beside the note it belongs to.
 */
export function attachmentFolder(
  vault: VaultConfig,
  noteRelPath?: string,
): string {
  // The app's own setting wins: a user who told us where attachments go
  // means it for the files WE add, whatever the vault's config says.
  let setting = (vault.attachmentFolder ?? "").trim();
  try {
    if (setting) throw new Error("override");
    const raw = readFileSync(join(vault.path, ".obsidian", "app.json"), "utf-8");
    const cfg = JSON.parse(raw) as { attachmentFolderPath?: unknown };
    if (typeof cfg.attachmentFolderPath === "string")
      setting = cfg.attachmentFolderPath.trim();
  } catch {
    /* no vault config, or hand-edited into invalid JSON — use the default */
  }
  // "/" and "" both mean the vault root in Obsidian's own settings.
  if (setting === "" || setting === "/") return "";
  if (setting.startsWith("./")) {
    // Per-note: beside the note, in the named subfolder.
    const sub = setting.slice(2).replace(/^\/+|\/+$/g, "");
    const dir = noteRelPath ? dirname(noteRelPath).replace(/^\.$/, "") : "";
    return [dir, sub].filter(Boolean).join("/");
  }
  return setting.replace(/^\/+|\/+$/g, "");
}

/**
 * A filename that is safe on every filesystem the app runs on — and that a
 * person still recognises.
 *
 * Only what Windows actually forbids is replaced. An earlier version also
 * ate hyphens and spaces, which renamed `00-cover.jpg` to `00_cover.jpg`
 * behind the model's back: it then had to guess the new names to write the
 * embeds, and guessed wrong. A name the caller chose survives.
 */
/** The characters Windows refuses in a filename. Listed as CODE POINTS
 * rather than as a regex class on purpose: a class holding a literal space
 * and hyphen is what silently ate the hyphen in `00-cover.jpg` (the model
 * then wrote embeds for names that did not exist), and the same construct
 * twice picked up a stray control byte in this very file. A set of numbers
 * cannot be misread by an editor, a formatter or a diff. */
const ILLEGAL_CODES = new Set([0x3c, 0x3e, 0x3a, 0x22, 0x7c, 0x3f, 0x2a]);

export function safeAttachmentName(name: string): string {
  // Basename without a regex: a path separator inside a character class
  // is one more thing that can lose a backslash in transit.
  const cut = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const base = cut >= 0 ? name.slice(cut + 1) : name;
  let out = "";
  for (const ch of base) {
    const code = ch.codePointAt(0) ?? 0;
    out += ILLEGAL_CODES.has(code) || code < 0x20 ? "_" : ch;
  }
  // A leading dot hides the file on POSIX and confuses Obsidian's picker.
  return out.replace(/^[.]+/, "").trim() || "file";
}

/** The name a copy should take when `name` is already in `dir`. */
export function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return `${stem}-${Date.now().toString(36)}${ext}`;
}

export interface AttachResult {
  /** Vault-relative path of the copy. */
  relPath: string;
  /** The name a wikilink/embed addresses it by. */
  name: string;
  kind: AttachmentKind;
  bytes: number;
}

/** Copy a file into the vault, atomically, without clobbering. */
export function copyIntoVault(
  vault: VaultConfig,
  sourceAbs: string,
  opts: { name?: string; noteRelPath?: string } = {},
): AttachResult {
  const size = statSync(sourceAbs).size;
  const folder = attachmentFolder(vault, opts.noteRelPath);
  const dirAbs = folder ? join(vault.path, folder) : vault.path;
  mkdirSync(dirAbs, { recursive: true });
  const wanted = safeAttachmentName(opts.name || sourceAbs);
  const name = freeName(dirAbs, wanted);
  const dest = join(dirAbs, name);
  // Copy to a temp name in the SAME folder, then rename: a sync client must
  // never see a half-written picture, and rename within a folder is atomic.
  const tmp = `${dest}.monet-tmp`;
  copyFileSync(sourceAbs, tmp);
  renameSync(tmp, dest);
  return {
    relPath: folder ? `${folder}/${name}` : name,
    name,
    kind: attachmentKind(name),
    bytes: size,
  };
}

/** How a note refers to this attachment. Images/video/audio embed; other
 * kinds link, because an embedded .zip renders as nothing. */
export function embedMarkdown(name: string, kind: AttachmentKind): string {
  return kind === "file" ? `[[${name}]]` : `![[${name}]]`;
}
