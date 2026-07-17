/**
 * WebDAV adapter — cloud files (Yandex Disk, Nextcloud, ownCloud…).
 *
 * webdav@5 is ESM-only and the main process is ESM, so it's imported lazily:
 * that also keeps its cost off startup for users with no files connector.
 * Auth is Basic with an app password — webdav.yandex.ru answers PROPFIND with
 * `WWW-Authenticate: Basic realm="Yandex.Disk"`.
 */

import { passwordShape } from "../store.js";
import type { ProtocolResult, ResolvedAccount } from "../types.js";

const MAX_TEXT = 20_000;

type DavClient = {
  getDirectoryContents: (path: string) => Promise<unknown>;
  getFileContents: (path: string, opts: { format: "text" }) => Promise<string>;
  putFileContents: (path: string, data: string) => Promise<boolean>;
  deleteFile: (path: string) => Promise<void>;
  createDirectory: (path: string) => Promise<void>;
};

async function client(acct: ResolvedAccount): Promise<DavClient> {
  const cfg = acct.preset.webdav;
  if (!cfg) throw new Error(`${acct.preset.name} has no WebDAV endpoint.`);
  const password = acct.secret.password;
  if (!password)
    throw new Error(
      `No app password stored for ${acct.account.label}. Reconnect it in Settings → Connectors.`,
    );
  const { createClient } = await import("webdav");
  return createClient(cfg.url, {
    username: acct.account.username,
    password,
  }) as unknown as DavClient;
}

interface DavStat {
  basename: string;
  type: string;
  size: number;
  lastmod: string;
  filename: string;
}

/** The webdav lib throws a bare "Invalid response: 401 Unauthorized", which
 * tells the user nothing they can act on — least of all that Yandex scopes app
 * passwords per service, so a Mail password is refused here on principle. */
function davError(e: unknown, acct: ResolvedAccount): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/401|unauthor/i.test(msg)) return e instanceof Error ? e : new Error(msg);
  return new Error(
    `${acct.preset.name} refused the credentials for “${acct.account.username}”. ` +
      `The app password must be the Files (WebDAV) type — one made for Mail or Calendar is rejected here. ` +
      `${passwordShape(acct.account.id)}; compare it with a connector that works. (Underlying: ${msg})`,
  );
}

export async function filesList(
  acct: ResolvedAccount,
  opts: { path?: string },
): Promise<ProtocolResult> {
  const c = await client(acct);
  const path = opts.path?.trim() || "/";
  const rows = (await c
    .getDirectoryContents(path)
    .catch((e: unknown) => {
      throw davError(e, acct);
    })) as DavStat[];
  if (!rows.length) return { ok: true, text: `${path} is empty.` };
  const text = rows
    .map((r) =>
      [
        r.type === "directory" ? "dir " : "file",
        r.type === "directory" ? "" : `${Math.round(r.size / 1024)}KB`,
        r.lastmod ? new Date(r.lastmod).toISOString().slice(0, 10) : "",
        r.basename,
      ]
        .filter(Boolean)
        .join("  "),
    )
    .join("\n");
  return { ok: true, text: `${path}\n${text}` };
}

export async function filesRead(
  acct: ResolvedAccount,
  opts: { path: string },
): Promise<ProtocolResult> {
  const c = await client(acct);
  const body = await c.getFileContents(opts.path, { format: "text" });
  const text = String(body);
  return {
    ok: true,
    text:
      text.slice(0, MAX_TEXT) + (text.length > MAX_TEXT ? "\n…[truncated]" : ""),
  };
}

export async function filesWrite(
  acct: ResolvedAccount,
  opts: { path: string; content: string },
): Promise<ProtocolResult> {
  const c = await client(acct);
  await c.putFileContents(opts.path, opts.content);
  return { ok: true, text: `Wrote ${opts.content.length} bytes to ${opts.path}.` };
}

export async function filesDelete(
  acct: ResolvedAccount,
  opts: { path: string },
): Promise<ProtocolResult> {
  const c = await client(acct);
  await c.deleteFile(opts.path);
  return { ok: true, text: `Deleted ${opts.path}.` };
}

export async function filesMkdir(
  acct: ResolvedAccount,
  opts: { path: string },
): Promise<ProtocolResult> {
  const c = await client(acct);
  await c.createDirectory(opts.path);
  return { ok: true, text: `Created ${opts.path}.` };
}
