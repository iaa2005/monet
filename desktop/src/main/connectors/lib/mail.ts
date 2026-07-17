/**
 * Shared IMAP/SMTP library. A mail service (GoogleGmail, YandexMail…) calls
 * makeMailOps() with its hosts and its own 401 wording — endpoints and
 * user-facing hints belong to the service folder, the wire logic lives here.
 *
 * Connections open per call and close in a finally: agent tool calls arrive
 * minutes apart, and a parked IMAP socket gets dropped by the server anyway.
 */

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { ProtocolResult } from "../types.js";
import type { MailOps, ResolvedAccount } from "../services/types.js";

const MAX_BODY = 8_000;

export interface MailConfig {
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** Appended to auth failures — the service knows WHY its server says no
   * (wrong password type, activation delay, IMAP toggle…). */
  authHint?: string;
}

function requireCreds(acct: ResolvedAccount): { user: string; pass: string } {
  const pass = acct.secret.password;
  if (!pass)
    throw new Error(
      `No app password stored for ${acct.account.label}. Reconnect it in Settings → Connectors.`,
    );
  return { user: acct.account.username, pass };
}

export function makeMailOps(cfg: MailConfig): MailOps {
  async function withImap<T>(
    acct: ResolvedAccount,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const client = new ImapFlow({
      host: cfg.imap.host,
      port: cfg.imap.port,
      secure: cfg.imap.secure,
      auth: requireCreds(acct),
      logger: false,
      // Fail fast instead of hanging a tool call on a wedged network.
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
    // MUST precede connect(): ImapFlow is an EventEmitter, and an 'error' with
    // no listener is a hard throw — a socket timing out AFTER its command
    // resolved once took down the whole main process.
    client.on("error", () => {});

    try {
      await client.connect();
    } catch (e) {
      throw imapError(e, acct);
    }
    try {
      return await fn(client);
    } catch (e) {
      throw imapError(e, acct);
    } finally {
      try {
        await client.logout();
      } catch {
        /* best-effort */
      }
    }
  }

  /** imapflow throws a bare `Error("Command failed")` and hides the server's
   * own words on responseText — usually the whole answer. Surface them, plus
   * the service's hint for auth failures. */
  function imapError(e: unknown, acct: ResolvedAccount): Error {
    const err = e as { message?: string; responseText?: string };
    const said = err.responseText?.trim();
    if (!said) return e instanceof Error ? e : new Error(String(e));
    const auth = /credentials|AUTHENTICATIONFAILED|disabled/i.test(said);
    const hint = auth && cfg.authHint ? ` — ${cfg.authHint}` : "";
    return new Error(`${acct.service.name} said: ${said}${hint}`);
  }

  return {
    async folders(acct) {
      return withImap(acct, async (c) => {
        const list = await c.list();
        const names = list.map(
          (f) => `${f.path}${f.subscribed ? "" : " (unsubscribed)"}`,
        );
        return { ok: true, text: names.join("\n") || "(no folders)" };
      });
    },

    /** Gmail advertises X-GM-EXT-1, so `query` passes through as real Gmail
     * search syntax there; elsewhere it falls back to IMAP OR-terms. */
    async search(acct, opts) {
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
      return withImap(acct, async (c) => {
        const folder = opts.folder || "INBOX";
        const lock = await c.getMailboxLock(folder);
        try {
          const gmail = !!c.capabilities.get("X-GM-EXT-1");
          const query = opts.query?.trim();
          const criteria = !query
            ? { all: true }
            : gmail
              ? ({ gmraw: query } as unknown as Record<string, unknown>)
              : { or: [{ subject: query }, { body: query }, { from: query }] };

          const uids = await c.search(criteria as never, { uid: true });
          if (!uids || uids.length === 0)
            return { ok: true, text: "(no matching messages)" };

          const recent = uids.slice(-limit).reverse();
          const rows: string[] = [];
          for await (const msg of c.fetch(
            recent as never,
            { uid: true, envelope: true, flags: true, size: true },
            { uid: true },
          )) {
            const e = msg.envelope;
            const from = e?.from?.[0];
            rows.push(
              [
                `uid=${msg.uid}`,
                e?.date
                  ? new Date(e.date).toISOString().slice(0, 16).replace("T", " ")
                  : "",
                from ? `${from.name || ""} <${from.address || ""}>`.trim() : "",
                `“${e?.subject || "(no subject)"}”`,
                msg.flags?.has("\\Seen") ? "" : "UNREAD",
              ]
                .filter(Boolean)
                .join("  "),
            );
          }
          return {
            ok: true,
            text: `${folder} — ${uids.length} match(es), showing ${rows.length}:\n${rows.join("\n")}`,
          };
        } finally {
          lock.release();
        }
      });
    },

    async read(acct, opts) {
      return withImap(acct, async (c) => {
        const folder = opts.folder || "INBOX";
        const lock = await c.getMailboxLock(folder);
        try {
          const msg = await c.fetchOne(
            String(opts.uid),
            { uid: true, envelope: true, source: true },
            { uid: true },
          );
          if (!msg || !msg.source)
            return {
              ok: false,
              text: "",
              error: `No message with uid ${opts.uid} in ${folder}.`,
            };

          // Parse just enough: headers, then the first text/plain part. A full
          // MIME parser is a heavier dependency than the agent needs.
          const raw = msg.source.toString("utf-8");
          const split = raw.indexOf("\r\n\r\n");
          const headers = split > 0 ? raw.slice(0, split) : "";
          let body = split > 0 ? raw.slice(split + 4) : raw;
          const boundary = /boundary="?([^";\r\n]+)"?/i.exec(headers)?.[1];
          if (boundary) {
            const part = body
              .split(`--${boundary}`)
              .find((p) => /content-type:\s*text\/plain/i.test(p));
            if (part) {
              const ps = part.indexOf("\r\n\r\n");
              if (ps > 0) body = part.slice(ps + 4);
            }
          }
          const e = msg.envelope;
          const head = [
            `From: ${e?.from?.map((a) => `${a.name || ""} <${a.address}>`).join(", ") ?? ""}`,
            `To: ${e?.to?.map((a) => a.address).join(", ") ?? ""}`,
            `Date: ${e?.date ? new Date(e.date).toISOString() : ""}`,
            `Subject: ${e?.subject ?? ""}`,
          ].join("\n");
          const trimmed = body.trim().slice(0, MAX_BODY);
          return {
            ok: true,
            text: `${head}\n\n${trimmed}${body.length > MAX_BODY ? "\n…[truncated]" : ""}`,
          };
        } finally {
          lock.release();
        }
      });
    },

    async send(acct, opts): Promise<ProtocolResult> {
      const creds = requireCreds(acct);
      const transport = nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.secure,
        auth: { user: creds.user, pass: creds.pass },
      });
      const info = await transport.sendMail({
        from: acct.account.username,
        to: opts.to,
        cc: opts.cc,
        subject: opts.subject,
        text: opts.body,
      });
      return { ok: true, text: `Sent to ${opts.to} (id ${info.messageId}).` };
    },
  };
}
