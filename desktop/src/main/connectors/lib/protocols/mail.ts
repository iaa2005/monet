/**
 * Shared IMAP/SMTP library. A mail service (GoogleGmail, YandexMail…) calls
 * makeMailOps() with its hosts and its own 401 wording — endpoints and
 * user-facing hints belong to the service folder, the wire logic lives here.
 *
 * Connections open per call and close in a finally: agent tool calls arrive
 * minutes apart, and a parked IMAP socket gets dropped by the server anyway.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { basename } from "path";
import type { ProtocolResult } from "../../types.js";
import type {
  ConnectorContext,
  MailOps,
  ResolvedAccount,
} from "../../services/types.js";

const MAX_BODY = 8_000;

/** One attachment as the body structure describes it. */
interface AttachmentPart {
  part: string;
  filename: string;
  size?: number;
}

/** Walk a bodyStructure tree collecting the attachment leaves. */
function collectAttachments(node: unknown, out: AttachmentPart[] = []): AttachmentPart[] {
  const n = node as {
    part?: string;
    type?: string;
    disposition?: string;
    dispositionParameters?: { filename?: string };
    parameters?: { name?: string };
    size?: number;
    childNodes?: unknown[];
  };
  if (n.childNodes?.length) {
    for (const child of n.childNodes) collectAttachments(child, out);
    return out;
  }
  const filename = n.dispositionParameters?.filename ?? n.parameters?.name;
  const attached = n.disposition?.toLowerCase() === "attachment" || !!filename;
  if (attached && n.part && !n.type?.startsWith("multipart/"))
    out.push({
      part: n.part,
      filename: filename || `part-${n.part}`,
      size: n.size,
    });
  return out;
}

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
            { uid: true, envelope: true, source: true, bodyStructure: true },
            { uid: true },
          );
          if (!msg || !msg.source)
            return {
              ok: false,
              text: "",
              error: `No message with uid ${opts.uid} in ${folder}.`,
            };

          const parsed = await simpleParser(msg.source);
          const body = parsed.text?.trim() ||
            (typeof parsed.html === "string" ? parsed.html.trim() : "");
          const e = msg.envelope;
          const head = [
            `From: ${e?.from?.map((a) => `${a.name || ""} <${a.address}>`).join(", ") ?? ""}`,
            `To: ${e?.to?.map((a) => a.address).join(", ") ?? ""}`,
            `Date: ${e?.date ? new Date(e.date).toISOString() : ""}`,
            `Subject: ${e?.subject ?? ""}`,
          ].join("\n");
          const trimmed = body.slice(0, MAX_BODY);
          const atts = msg.bodyStructure
            ? collectAttachments(msg.bodyStructure)
            : [];
          const attLine = atts.length
            ? `\n\nAttachments (download_attachment takes index or name):\n${atts
                .map(
                  (a, i) =>
                    `[${i + 1}] ${a.filename}${a.size ? ` (${Math.round(a.size / 1024)}KB)` : ""}`,
                )
                .join("\n")}`
            : "";
          return {
            ok: true,
            text: `${head}\n\n${trimmed}${body.length > MAX_BODY ? "\n…[truncated]" : ""}${attLine}`,
          };
        } finally {
          lock.release();
        }
      });
    },

    async send(acct, opts, ctx): Promise<ProtocolResult> {
      const creds = requireCreds(acct);
      // Resolve attachments through the FileBridge BEFORE opening SMTP: a
      // path outside the chat's file area must fail the call, not the socket.
      const files = (opts.attachments ?? []).map((p) => {
        const abs = ctx.files.resolveRead(p);
        return { filename: basename(abs), path: abs };
      });
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
        ...(files.length ? { attachments: files } : {}),
      });
      return {
        ok: true,
        text: `Sent to ${opts.to}${files.length ? ` with ${files.length} attachment(s)` : ""} (id ${info.messageId}).`,
      };
    },

    async downloadAttachment(
      acct,
      opts,
      ctx: ConnectorContext,
    ): Promise<ProtocolResult> {
      return withImap(acct, async (c) => {
        const folder = opts.folder || "INBOX";
        const lock = await c.getMailboxLock(folder);
        try {
          const msg = await c.fetchOne(
            String(opts.uid),
            { uid: true, bodyStructure: true },
            { uid: true },
          );
          if (!msg || !msg.bodyStructure)
            return {
              ok: false,
              text: "",
              error: `No message with uid ${opts.uid} in ${folder}.`,
            };
          const atts = collectAttachments(msg.bodyStructure);
          if (!atts.length)
            return { ok: false, text: "", error: "This message has no attachments." };

          const wanted = opts.name?.trim().toLowerCase();
          const pick = wanted
            ? (atts.find((a) => a.filename.toLowerCase() === wanted) ??
              atts.find((a) => a.filename.toLowerCase().includes(wanted)))
            : atts[(opts.index ?? 1) - 1];
          if (!pick)
            return {
              ok: false,
              text: "",
              error: `No attachment ${opts.name ? `“${opts.name}”` : `#${opts.index}`}. Available: ${atts
                .map((a, i) => `[${i + 1}] ${a.filename}`)
                .join(", ")}`,
            };

          const dl = await c.download(String(opts.uid), pick.part, { uid: true });
          if (!dl?.content)
            return {
              ok: false,
              text: "",
              error: "The server returned no content for that attachment.",
            };
          const saved = await ctx.files.write(pick.filename, dl.content);
          return {
            ok: true,
            text: `Saved ${pick.filename}${pick.size ? ` (${Math.round(pick.size / 1024)}KB)` : ""}\n${saved.artifactLine}`,
          };
        } finally {
          lock.release();
        }
      });
    },
  };
}
