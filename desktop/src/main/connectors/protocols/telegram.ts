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
import { patchSecret } from "../store.js";
import type { ProtocolResult, ResolvedAccount } from "../types.js";

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
      const unread = d.unreadCount ? ` [${d.unreadCount} unread]` : "";
      return `${d.id?.toString() ?? "?"}  ${d.title ?? d.name ?? "(untitled)"}${unread}`;
    });
    return { ok: true, text: rows.join("\n") || "(no chats)" };
  });
}

export async function telegramHistory(
  acct: ResolvedAccount,
  opts: { chat: string; limit?: number; query?: string },
): Promise<ProtocolResult> {
  return withClient(acct, async (c) => {
    const msgs = await c.getMessages(opts.chat, {
      limit: Math.min(Math.max(opts.limit ?? 30, 1), 100),
      ...(opts.query ? { search: opts.query } : {}),
    });
    const rows = msgs
      .filter((m) => m.message)
      .map((m) => {
        const who =
          (m.sender as { username?: string; firstName?: string } | undefined)
            ?.username ??
          (m.sender as { firstName?: string } | undefined)?.firstName ??
          m.senderId?.toString() ??
          "?";
        const at = m.date ? new Date(m.date * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
        return `${at}  ${who}: ${m.message}`;
      })
      .reverse();
    return { ok: true, text: rows.join("\n") || "(no messages)" };
  });
}

export async function telegramSend(
  acct: ResolvedAccount,
  opts: { chat: string; message: string },
): Promise<ProtocolResult> {
  return withClient(acct, async (c) => {
    await c.sendMessage(opts.chat, { message: opts.message });
    return { ok: true, text: `Sent to ${opts.chat}.` };
  });
}
