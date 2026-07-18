/**
 * Google Drive adapter (Drive API v3, OAuth).
 *
 * Drive is the one Google service with no standard protocol at all — no
 * WebDAV, no DAV of any kind, only this REST API behind OAuth. So it can't
 * reuse the WebDAV adapter and gets its own, exposed through the same
 * CloudFiles tool: a protocol is a module, a service is a row.
 *
 * The awkward part is that Drive HAS NO PATHS. Files are ids, names aren't
 * unique, and two files can share a name in one folder. Everything here takes
 * the path the model naturally writes ("/Docs/notes.md") and walks it down from
 * the root, one lookup per segment. That costs a round-trip per level, which is
 * the price of a sane tool surface.
 */

import { extname } from "path";
import { fetchRetry } from "../../../../net-fetch.js";
import { googleAccessToken } from "../auth.js";
import { patchSecret } from "../../../store.js";
import { mimeOf } from "../../../lib/file-bridge.js";
import type { ProtocolResult } from "../../../types.js";
import type {
  ConnectorContext,
  FileOps,
  ResolvedAccount,
} from "../../types.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const MAX_TEXT = 20_000;

/** Google-native docs have no bytes to download — they must be exported. */
const EXPORT_AS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

async function token(acct: ResolvedAccount): Promise<string> {
  const t = await googleAccessToken(acct.secret);
  if (t.accessToken !== acct.secret.accessToken) patchSecret(acct.account.id, t);
  return t.accessToken;
}

async function api<T>(
  bearer: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetchRetry(url, {
    ...init,
    headers: { authorization: `Bearer ${bearer}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(
      `Drive: ${body.error?.message ?? `${res.status} ${res.statusText}`}`,
    );
  }
  return (await res.json()) as T;
}

/** A name inside a `q` filter is a quoted string — escape or a file called
 * `it's.txt` breaks the query rather than being not-found. */
function q(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Resolve a path to a file, walking name-by-name from the root. */
async function resolve(
  bearer: string,
  path: string,
): Promise<DriveFile | null> {
  let parent = "root";
  let current: DriveFile | null = null;
  for (const name of segments(path)) {
    const url =
      `${API}/files?q=${encodeURIComponent(`'${parent}' in parents and name='${q(name)}' and trashed=false`)}` +
      `&fields=${encodeURIComponent("files(id,name,mimeType,size,modifiedTime)")}&pageSize=2`;
    const { files } = await api<{ files: DriveFile[] }>(bearer, url);
    if (!files?.length) return null;
    current = files[0];
    parent = files[0].id;
  }
  return current ?? { id: "root", name: "/", mimeType: FOLDER };
}

async function resolveOrThrow(bearer: string, path: string): Promise<DriveFile> {
  const f = await resolve(bearer, path);
  if (!f) throw new Error(`No such file in Drive: ${path}`);
  return f;
}

export async function driveList(
  acct: ResolvedAccount,
  opts: { path?: string },
): Promise<ProtocolResult> {
  const bearer = await token(acct);
  const path = opts.path?.trim() || "/";
  const folder = await resolveOrThrow(bearer, path);
  const url =
    `${API}/files?q=${encodeURIComponent(`'${folder.id}' in parents and trashed=false`)}` +
    `&fields=${encodeURIComponent("files(id,name,mimeType,size,modifiedTime)")}&pageSize=200` +
    `&orderBy=${encodeURIComponent("folder,name")}`;
  const { files } = await api<{ files: DriveFile[] }>(bearer, url);
  if (!files?.length) return { ok: true, text: `${path} is empty.` };
  const rows = files.map((f) => {
    const dir = f.mimeType === FOLDER;
    const native = f.mimeType.startsWith("application/vnd.google-apps.");
    return [
      dir ? "dir " : "file",
      dir || !f.size ? "" : `${Math.round(Number(f.size) / 1024)}KB`,
      f.modifiedTime ? f.modifiedTime.slice(0, 10) : "",
      f.name,
      native && !dir ? `(${f.mimeType.split(".").pop()})` : "",
    ]
      .filter(Boolean)
      .join("  ");
  });
  return { ok: true, text: `${path}\n${rows.join("\n")}` };
}

export async function driveRead(
  acct: ResolvedAccount,
  opts: { path: string },
): Promise<ProtocolResult> {
  const bearer = await token(acct);
  const file = await resolveOrThrow(bearer, opts.path);
  if (file.mimeType === FOLDER)
    return { ok: false, text: "", error: `${opts.path} is a folder.` };

  const exportAs = EXPORT_AS[file.mimeType];
  const url = exportAs
    ? `${API}/files/${file.id}/export?mimeType=${encodeURIComponent(exportAs)}`
    : `${API}/files/${file.id}?alt=media`;
  const res = await fetchRetry(url, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!res.ok)
    return {
      ok: false,
      text: "",
      error: `Drive: couldn't read ${opts.path} (${res.status}).`,
    };
  const text = await res.text();
  return {
    ok: true,
    text:
      text.slice(0, MAX_TEXT) + (text.length > MAX_TEXT ? "\n…[truncated]" : ""),
  };
}

export async function driveWrite(
  acct: ResolvedAccount,
  opts: { path: string; content: string },
): Promise<ProtocolResult> {
  const bearer = await token(acct);
  const parts = segments(opts.path);
  const name = parts.pop();
  if (!name) return { ok: false, text: "", error: "A file path is required." };

  const existing = await resolve(bearer, opts.path);
  if (existing && existing.mimeType !== FOLDER) {
    // Update in place: keeps the id, so shares and links survive an edit.
    await api(
      bearer,
      `${UPLOAD}/files/${existing.id}?uploadType=media`,
      {
        method: "PATCH",
        headers: { "content-type": "text/plain" },
        body: opts.content,
      },
    );
    return { ok: true, text: `Updated ${opts.path} (${opts.content.length} bytes).` };
  }

  const parent = parts.length ? await resolveOrThrow(bearer, parts.join("/")) : null;
  // Multipart: metadata and bytes in one request, per Drive's upload protocol.
  const boundary = `monet-${Date.now()}`;
  const meta = JSON.stringify({
    name,
    ...(parent ? { parents: [parent.id] } : {}),
  });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${opts.content}\r\n` +
    `--${boundary}--`;
  await api(bearer, `${UPLOAD}/files?uploadType=multipart`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return { ok: true, text: `Created ${opts.path} (${opts.content.length} bytes).` };
}

export async function driveDelete(
  acct: ResolvedAccount,
  opts: { path: string },
): Promise<ProtocolResult> {
  const bearer = await token(acct);
  const file = await resolveOrThrow(bearer, opts.path);
  // Trash rather than delete: this is the user's real Drive, and an agent
  // mis-resolving a path shouldn't be unrecoverable.
  await api(bearer, `${API}/files/${file.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
  return { ok: true, text: `Moved ${opts.path} to Drive's trash.` };
}

export async function driveMkdir(
  acct: ResolvedAccount,
  opts: { path: string },
): Promise<ProtocolResult> {
  const bearer = await token(acct);
  const parts = segments(opts.path);
  const name = parts.pop();
  if (!name) return { ok: false, text: "", error: "A folder path is required." };
  const parent = parts.length ? await resolveOrThrow(bearer, parts.join("/")) : null;
  await api(bearer, `${API}/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: FOLDER,
      ...(parent ? { parents: [parent.id] } : {}),
    }),
  });
  return { ok: true, text: `Created folder ${opts.path}.` };
}

export async function driveDownload(
  acct: ResolvedAccount,
  opts: { path: string; saveAs?: string },
  ctx: ConnectorContext,
): Promise<ProtocolResult> {
  const bearer = await token(acct);
  const file = await resolveOrThrow(bearer, opts.path);
  if (file.mimeType === FOLDER)
    return { ok: false, text: "", error: `${opts.path} is a folder.` };

  const exportAs = EXPORT_AS[file.mimeType];
  const url = exportAs
    ? `${API}/files/${file.id}/export?mimeType=${encodeURIComponent(exportAs)}`
    : `${API}/files/${file.id}?alt=media`;
  const res = await fetchRetry(url, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!res.ok)
    return {
      ok: false,
      text: "",
      error: `Drive: couldn't download ${opts.path} (${res.status}).`,
    };
  const data = Buffer.from(await res.arrayBuffer());
  let name = opts.saveAs || file.name;
  // A Google-native doc exports without an extension of its own — add one.
  if (exportAs && !extname(name))
    name += exportAs === "text/csv" ? ".csv" : ".txt";
  const saved = await ctx.files.write(name, data);
  return {
    ok: true,
    text: `Downloaded ${opts.path} (${Math.round(data.length / 1024)}KB${exportAs ? `, exported as ${exportAs}` : ""})\n${saved.artifactLine}`,
  };
}

export async function driveUpload(
  acct: ResolvedAccount,
  opts: { file: string; path: string },
  ctx: ConnectorContext,
): Promise<ProtocolResult> {
  const abs = ctx.files.resolveRead(opts.file);
  const { readFile } = await import("fs/promises");
  const data = await readFile(abs);
  const localName = abs.split(/[/\\]/).pop() ?? "file";
  const bearer = await token(acct);

  // Naming a folder (or "/") means "into it, keep the local name".
  let destPath = opts.path.trim() || "/";
  const destNode = await resolve(bearer, destPath);
  if (destNode?.mimeType === FOLDER)
    destPath = `${destPath.replace(/\/+$/, "")}/${localName}`;

  const mime = mimeOf(localName);
  const existing = await resolve(bearer, destPath);
  if (existing && existing.mimeType !== FOLDER) {
    await api(bearer, `${UPLOAD}/files/${existing.id}?uploadType=media`, {
      method: "PATCH",
      headers: { "content-type": mime },
      body: data,
    });
    return {
      ok: true,
      text: `Updated ${destPath} (${Math.round(data.length / 1024)}KB).`,
    };
  }

  const parts = segments(destPath);
  const name = parts.pop() ?? localName;
  const parent = parts.length
    ? await resolveOrThrow(bearer, parts.join("/"))
    : null;
  const boundary = `monet-${Date.now()}`;
  const meta = JSON.stringify({
    name,
    ...(parent ? { parents: [parent.id] } : {}),
  });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
      "utf8",
    ),
    data,
    Buffer.from(`\r\n--${boundary}--`, "utf8"),
  ]);
  await api(bearer, `${UPLOAD}/files?uploadType=multipart`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return {
    ok: true,
    text: `Uploaded ${localName} → ${destPath} (${Math.round(data.length / 1024)}KB).`,
  };
}

/** The FileOps bundle a Drive-backed service plugs into `capabilities.files`. */
export const driveOps: FileOps = {
  list: (a, o) => driveList(a, o),
  read: (a, o) => driveRead(a, o),
  write: (a, o) => driveWrite(a, o),
  delete: (a, o) => driveDelete(a, o),
  mkdir: (a, o) => driveMkdir(a, o),
  download: (a, o, ctx) => driveDownload(a, o, ctx),
  upload: (a, o, ctx) => driveUpload(a, o, ctx),
};
