/**
 * Telegram adapter — MTProto against the user's OWN account (GramJS).
 *
 * A bot can only ever see chats it was added to, so reading your real
 * conversations requires a user session: api_id/api_hash from my.telegram.org,
 * then a phone-code login. The resulting StringSession is stored encrypted and
 * reused, so the code prompt happens once.
 *
 * Login is two IPC round-trips (send code → sign in), so the half-built client
 * is parked in `pending` between them rather than blocking on a callback.
 */

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { patchSecret } from "../../store.js";
import type { ProtocolResult } from "../../types.js";
import type { ChatOps, ConnectorContext, ResolvedAccount } from "../types.js";

interface Pending {
  client: TelegramClient;
  phoneCodeHash: string;
  phone: string;
}
const pending = new Map<string, Pending>();

function makeClient(apiId: string, apiHash: string, session: string): TelegramClient {
  return new TelegramClient(new StringSession(session), Number(apiId), apiHash, {
    connectionRetries: 3,
    // Don't let a dead network wedge a tool call forever.
    timeout: 20,
  });
}

/** Step 1 of login: ask Telegram to send the confirmation code. */
export async function telegramSendCode(opts: {
  accountId: string;
  apiId: string;
  apiHash: string;
  phone: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = makeClient(opts.apiId, opts.apiHash, "");
    await client.connect();
    const res = await client.sendCode(
      { apiId: Number(opts.apiId), apiHash: opts.apiHash },
      opts.phone,
    );
    pending.set(opts.accountId, {
      client,
      phoneCodeHash: res.phoneCodeHash,
      phone: opts.phone,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Step 2: submit the code (and 2FA password if the account has one). */
export async function telegramSignIn(opts: {
  accountId: string;
  code: string;
  password?: string;
}): Promise<{ ok: boolean; error?: string; needsPassword?: boolean }> {
  const p = pending.get(opts.accountId);
  if (!p)
    return { ok: false, error: "Login expired — start again from Connectors." };
  try {
    await p.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: p.phone,
        phoneCodeHash: p.phoneCodeHash,
        phoneCode: opts.code,
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Account has 2FA on: the code alone isn't enough.
    if (/SESSION_PASSWORD_NEEDED/i.test(msg)) {
      if (!opts.password) return { ok: false, needsPassword: true, error: "2FA password required." };
      try {
        await p.client.signInWithPassword(
          { apiId: 0, apiHash: "" },
          {
            password: async () => opts.password as string,
            onError: (err) => {
              throw err;
            },
          },
        );
      } catch (e2) {
        return { ok: false, error: e2 instanceof Error ? e2.message : String(e2) };
      }
    } else {
      return { ok: false, error: msg };
    }
  }

  const session = String(p.client.session.save());
  patchSecret(opts.accountId, { session });
  pending.delete(opts.accountId);
  try {
    await p.client.disconnect();
  } catch {
    /* best-effort */
  }
  return { ok: true };
}

async function withClient<T>(
  acct: ResolvedAccount,
  fn: (c: TelegramClient) => Promise<T>,
): Promise<T> {
  const { apiId, apiHash, session } = acct.secret;
  if (!apiId || !apiHash || !session)
    throw new Error(
      `${acct.account.label} isn't signed in. Connect it in Settings → Connectors.`,
    );
  const client = makeClient(apiId, apiHash, session);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* best-effort */
    }
  }
}

export async function telegramChats(
  acct: ResolvedAccount,
  opts: { limit?: number },
): Promise<ProtocolResult> {
  return withClient(acct, async (c) => {
    const dialogs = await c.getDialogs({
      limit: Math.min(Math.max(opts.limit ?? 30, 1), 100),
    });
    const rows = dialogs.map((d) => {
      const e = d.entity as { forum?: boolean; broadcast?: boolean } | undefined;
      // Spelling out the kind saves a round-trip: a forum needs a topic id to
      // post into, and a broadcast channel needs admin rights to post at all.
      const kind = d.isUser
        ? "dm"
        : e?.broadcast
          ? "channel"
          : e?.forum
            ? "forum"
            : d.isChannel || d.isGroup
              ? "group"
              : "chat";
      const unread = d.unreadCount ? ` [${d.unreadCount} unread]` : "";
      return `${d.id?.toString() ?? "?"}  ${kind.padEnd(7)} ${d.title ?? d.name ?? "(untitled)"}${unread}`;
    });
    return { ok: true, text: rows.join("\n") || "(no chats)" };
  });
}

/** Forum topics of a group. Their ids double as the reply target you post to. */
export async function telegramTopics(
  acct: ResolvedAccount,
  opts: { chat: string; limit?: number },
): Promise<ProtocolResult> {
  return withClient(acct, async (c) => {
    const entity = await c.getInputEntity(opts.chat);
    const res = (await c.invoke(
      new Api.channels.GetForumTopics({
        channel: entity,
        limit: Math.min(Math.max(opts.limit ?? 50, 1), 100),
        offsetDate: 0,
        offsetId: 0,
        offsetTopic: 0,
      }),
    )) as unknown as {
      topics: { id?: number; title?: string; closed?: boolean }[];
    };
    const rows = (res.topics ?? []).map(
      (t) => `${t.id}  ${t.title ?? "(untitled)"}${t.closed ? " [closed]" : ""}`,
    );
    return {
      ok: true,
      text: rows.join("\n") || "(no topics — this chat isn't a forum)",
    };
  });
}

export async function telegramHistory(
  acct: ResolvedAccount,
  opts: { chat: string; limit?: number; query?: string; topic?: number },
): Promise<ProtocolResult> {
  return withClient(acct, async (c) => {
    const msgs = await c.getMessages(opts.chat, {
      limit: Math.min(Math.max(opts.limit ?? 30, 1), 100),
      ...(opts.query ? { search: opts.query } : {}),
      // Messages of a forum topic are the replies to its root message.
      ...(opts.topic ? { replyTo: opts.topic } : {}),
    });
    const rows = msgs
      // Media-only messages stay: their id is what download_media needs.
      .filter((m) => m.message || m.media)
      .map((m) => {
        const who =
          (m.sender as { username?: string; firstName?: string } | undefined)
            ?.username ??
          (m.sender as { firstName?: string } | undefined)?.firstName ??
          m.senderId?.toString() ??
          "?";
        const at = m.date ? new Date(m.date * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
        const media = m.media ? ` [media: ${mediaFilename(m) ?? "photo/video"}]` : "";
        return `#${m.id}  ${at}  ${who}: ${m.message ?? ""}${media}`.trimEnd();
      })
      .reverse();
    return {
      ok: true,
      text: rows.length
        ? `${rows.join("\n")}\n(#N is the message id — download_media takes it)`
        : "(no messages)",
    };
  });
}

export async function telegramSend(
  acct: ResolvedAccount,
  opts: { chat: string; message: string; topic?: number },
): Promise<ProtocolResult> {
  return withClient(acct, async (c) => {
    // A forum topic IS a message — posting into one is a reply to its root.
    await c.sendMessage(opts.chat, {
      message: opts.message,
      ...(opts.topic ? { replyTo: opts.topic } : {}),
    });
    return {
      ok: true,
      text: `Sent to ${opts.chat}${opts.topic ? ` (topic ${opts.topic})` : ""}.`,
    };
  });
}

export async function telegramSendFile(
  acct: ResolvedAccount,
  opts: {
    chat: string;
    file: string;
    caption?: string;
    topic?: number;
    asDocument?: boolean;
  },
  ctx: ConnectorContext,
): Promise<ProtocolResult> {
  // A URL is handed to Telegram to fetch itself; a path goes through the
  // FileBridge, which fences Home to the chat's sandbox (a model could
  // otherwise read C:\Users\…\secrets and post it out, straight through the
  // isolation Home exists to provide).
  const file = /^https?:\/\//i.test(opts.file)
    ? opts.file
    : ctx.files.resolveRead(opts.file);
  return withClient(acct, async (c) => {
    await c.sendFile(opts.chat, {
      file,
      ...(opts.caption ? { caption: opts.caption } : {}),
      ...(opts.topic ? { replyTo: opts.topic } : {}),
      // Off by default, so an .mp4/.jpg arrives as playable video / a viewable
      // photo rather than a file to download.
      forceDocument: opts.asDocument === true,
    });
    return {
      ok: true,
      text: `Sent ${opts.file} to ${opts.chat}${opts.topic ? ` (topic ${opts.topic})` : ""}.`,
    };
  });
}

/** Best filename for a message's media: the document's own name, else an
 * extension guess for photos. */
function mediaFilename(m: unknown): string | null {
  const doc = (
    m as { document?: { attributes?: { className?: string; fileName?: string }[] } }
  ).document;
  const named = doc?.attributes?.find(
    (a) => a.className === "DocumentAttributeFilename",
  );
  if (named?.fileName) return named.fileName;
  if ((m as { photo?: unknown }).photo) return null; // photo: name at save time
  return null;
}

export async function telegramDownloadMedia(
  acct: ResolvedAccount,
  opts: { chat: string; id: number },
  ctx: ConnectorContext,
): Promise<ProtocolResult> {
  return withClient(acct, async (c) => {
    const msgs = await c.getMessages(opts.chat, { ids: [opts.id] });
    const m = msgs?.[0];
    if (!m)
      return {
        ok: false,
        text: "",
        error: `No message #${opts.id} in ${opts.chat}.`,
      };
    if (!m.media)
      return { ok: false, text: "", error: `Message #${opts.id} has no media.` };
    const data = await c.downloadMedia(m, {});
    if (!Buffer.isBuffer(data) || data.length === 0)
      return { ok: false, text: "", error: "Telegram returned no bytes for that media." };
    const name =
      mediaFilename(m) ??
      ((m as { photo?: unknown }).photo
        ? `telegram-${opts.id}.jpg`
        : `telegram-${opts.id}.bin`);
    const saved = await ctx.files.write(name, data);
    return {
      ok: true,
      text: `Saved media from #${opts.id} (${Math.round(data.length / 1024)}KB)\n${saved.artifactLine}`,
    };
  });
}

/** The ChatOps bundle the Telegram service plugs into `capabilities.chat`. */
export const telegramOps: ChatOps = {
  chats: (a, o) => telegramChats(a, o),
  topics: (a, o) => telegramTopics(a, o),
  history: (a, o) => telegramHistory(a, o),
  send: (a, o) => telegramSend(a, o),
  sendFile: (a, o, ctx) => telegramSendFile(a, o, ctx),
  downloadMedia: (a, o, ctx) => telegramDownloadMedia(a, o, ctx),
};
