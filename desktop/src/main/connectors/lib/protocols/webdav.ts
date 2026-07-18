/**
 * Shared WebDAV library. A files service (YandexDisk, a future Nextcloud…)
 * calls makeWebdavOps() with its URL and its own 401 wording.
 *
 * webdav@5 is ESM-only, so it's imported lazily — that also keeps its cost off
 * startup for users with no files connector.
 */

import { basename } from "path";
import type { FileOps, ResolvedAccount } from "../../services/types.js";

const MAX_TEXT = 20_000;

export interface WebdavConfig {
  url: string;
  /** Appended to 401s — the service knows what its server actually wants. */
  authHint?: string;
}

interface DavClient {
  getDirectoryContents(path: string): Promise<unknown>;
  getFileContents(path: string, opts: { format: "text" }): Promise<string>;
  getFileContents(path: string, opts: { format: "binary" }): Promise<ArrayBuffer>;
  putFileContents(path: string, data: string | Buffer): Promise<boolean>;
  deleteFile(path: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
}

interface DavStat {
  basename: string;
  type: string;
  size: number;
  lastmod: string;
  filename: string;
}

export function makeWebdavOps(cfg: WebdavConfig): FileOps {
  async function client(acct: ResolvedAccount): Promise<DavClient> {
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

  /** The webdav lib throws a bare "Invalid response: 401 Unauthorized" — say
   * what the user can actually check, in the service's own words. */
  function davError(e: unknown, acct: ResolvedAccount): Error {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/401|unauthor/i.test(msg))
      return e instanceof Error ? e : new Error(msg);
    return new Error(
      `${acct.service.name} refused the credentials for “${acct.account.username}”.` +
        (cfg.authHint ? ` ${cfg.authHint}` : "") +
        ` (Underlying: ${msg})`,
    );
  }

  const guard = async <T>(acct: ResolvedAccount, p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      throw davError(e, acct);
    }
  };

  return {
    async list(acct, opts) {
      const c = await client(acct);
      const path = opts.path?.trim() || "/";
      const rows = (await guard(acct, c.getDirectoryContents(path))) as DavStat[];
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
    },

    async read(acct, opts) {
      const c = await client(acct);
      const body = await guard(
        acct,
        c.getFileContents(opts.path, { format: "text" }),
      );
      const text = String(body);
      return {
        ok: true,
        text:
          text.slice(0, MAX_TEXT) +
          (text.length > MAX_TEXT ? "\n…[truncated]" : ""),
      };
    },

    async write(acct, opts) {
      const c = await client(acct);
      await guard(acct, c.putFileContents(opts.path, opts.content));
      return {
        ok: true,
        text: `Wrote ${opts.content.length} bytes to ${opts.path}.`,
      };
    },

    async delete(acct, opts) {
      const c = await client(acct);
      await guard(acct, c.deleteFile(opts.path));
      return { ok: true, text: `Deleted ${opts.path}.` };
    },

    async mkdir(acct, opts) {
      const c = await client(acct);
      await guard(acct, c.createDirectory(opts.path));
      return { ok: true, text: `Created ${opts.path}.` };
    },

    async download(acct, opts, ctx) {
      const c = await client(acct);
      const raw = await guard(
        acct,
        c.getFileContents(opts.path, { format: "binary" }),
      );
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const saved = await ctx.files.write(
        opts.saveAs || basename(opts.path),
        data,
      );
      return {
        ok: true,
        text: `Downloaded ${opts.path} (${Math.round(data.length / 1024)}KB)\n${saved.artifactLine}`,
      };
    },

    async upload(acct, opts, ctx) {
      const abs = ctx.files.resolveRead(opts.file);
      const { readFile } = await import("fs/promises");
      const data = await readFile(abs);
      const c = await client(acct);
      // A trailing slash (or naming a folder) means "into it, keep the name".
      const remote = opts.path.endsWith("/")
        ? `${opts.path}${basename(abs)}`
        : opts.path;
      await guard(acct, c.putFileContents(remote, data));
      return {
        ok: true,
        text: `Uploaded ${basename(abs)} → ${remote} (${Math.round(data.length / 1024)}KB).`,
      };
    },
  };
}
