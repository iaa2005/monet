/**
 * Mail adapter — IMAP (read/search) + SMTP (send).
 *
 * One adapter serves every mail provider; the preset supplies host/port. Auth is
 * AUTH=PLAIN with an app password, which both imap.gmail.com and imap.yandex.ru
 * advertise, so no OAuth client is involved.
 *
 * Connections are opened per call and closed in a finally — an agent tool may be
 * invoked minutes apart, and a parked IMAP socket just gets dropped by the
 * server anyway.
 */

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { ProtocolResult, ResolvedAccount } from "../types.js";

const MAX_BODY = 8_000;

function requireCreds(acct: ResolvedAccount): { user: string; pass: string } {
  const pass = acct.secret.password;
  if (!pass)
    throw new Error(
      `No app password stored for ${acct.account.label}. Reconnect it in Settings → Connectors.`,
    );
  return { user: acct.account.username, pass };
}

async function withImap<T>(
  acct: ResolvedAccount,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const cfg = acct.preset.imap;
  if (!cfg) throw new Error(`${acct.preset.name} has no IMAP endpoint.`);
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: requireCreds(acct),
    logger: false,
    // Fail fast instead of hanging a tool call on a wedged network.
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  // MUST come before connect(). ImapFlow is an EventEmitter, and an 'error' with
  // no listener is a hard throw — so a socket that times out AFTER its command
  // resolved (which is the normal end of a connection Yandex has already
  // dropped) took down the whole main process with "A JavaScript error occurred".
  // The awaited calls below report failures on their own; this event has nobody
  // left to tell, so swallow it.
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

/**
 * imapflow throws a bare `Error("Command failed")` and hides the server's own
 * words on `responseText` — which is a shame, because they're usually the whole
 * answer. Yandex, for one, replies "invalid credentials or IMAP is disabled":
 * two very different problems, and the second isn't fixable by re-checking the
 * password you already checked.
 */
function imapError(e: unknown, acct: ResolvedAccount): Error {
  const err = e as {
    message?: string;
    responseText?: string;
    authenticationFailed?: boolean;
  };
  const said = err.responseText?.trim();
  if (!said) return e instanceof Error ? e : new Error(String(e));

  const hint = /IMAP is disabled/i.test(said)
    ? ` — turn IMAP on in ${acct.preset.name}'s settings (Mail → Mail clients), then Test again. If it's already on, the app password may be the wrong type.`
    : /credentials|AUTHENTICATIONFAILED/i.test(said)
      ? ` — check the app password, and that it's the type this connector needs.`
      : "";
  return new Error(`${acct.preset.name} said: ${said}${hint}`);
}

export async function mailFolders(acct: ResolvedAccount): Promise<ProtocolResult> {
  return withImap(acct, async (c) => {
    const list = await c.list();
    const names = list.map((f) => `${f.path}${f.subscribed ? "" : " (unsubscribed)"}`);
    return { ok: true, text: names.join("\n") || "(no folders)" };
  });
}

/**
 * Search a mailbox. Gmail advertises X-GM-EXT-1, so `query` is passed straight
 * through as a real Gmail search ("from:bob has:attachment") — far better than
 * IMAP's primitive terms. Elsewhere it falls back to an IMAP TEXT search.
 */
export async function mailSearch(
  acct: ResolvedAccount,
  opts: { query?: string; folder?: string; limit?: number },
): Promise<ProtocolResult> {
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
            e?.date ? new Date(e.date).toISOString().slice(0, 16).replace("T", " ") : "",
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
}

export async function mailRead(
  acct: ResolvedAccount,
  opts: { uid: number; folder?: string },
): Promise<ProtocolResult> {
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
        return { ok: false, text: "", error: `No message with uid ${opts.uid} in ${folder}.` };

      // Parse just enough: headers, then the first text part. Pulling in a full
      // MIME parser for this would be a heavier dependency than it's worth.
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
}

export async function mailSend(
  acct: ResolvedAccount,
  opts: { to: string; subject: string; body: string; cc?: string },
): Promise<ProtocolResult> {
  const cfg = acct.preset.smtp;
  if (!cfg) throw new Error(`${acct.preset.name} has no SMTP endpoint.`);
  const creds = requireCreds(acct);
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
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
}
