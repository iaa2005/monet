/**
 * Telegram Bot API adapter (api.telegram.org/bot<token>/…).
 *
 * Honest capability mapping: send/sendFile do exactly what bots do best;
 * chats/history are derived from getUpdates, i.e. only what the bot has been
 * sent recently (Telegram keeps updates ~24h and this client does not consume
 * them, so repeated reads keep working); topics and downloadMedia exist on the
 * interface but explain what a bot cannot do rather than pretending.
 */

import { fetchRetry } from "../../../../net-fetch.js";
import { mimeOf } from "../../../lib/file-bridge.js";
import type { ProtocolResult } from "../../../types.js";
import type {
  ChatOps,
  ConnectorContext,
  ResolvedAccount,
} from "../../types.js";

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    from?: { username?: string; first_name?: string };
    chat: {
      id: number;
      type: string;
      title?: string;
      username?: string;
      first_name?: string;
    };
    document?: { file_name?: string };
    photo?: unknown[];
  };
}

function tokenOf(acct: ResolvedAccount): string {
  const t = acct.secret.password;
  if (!t)
    throw new Error(
      `No bot token stored for ${acct.account.label}. Reconnect it in Settings → Connectors.`,
    );
  return t;
}

async function botApi<T>(
  acct: ResolvedAccount,
  method: string,
  body?: Record<string, unknown> | FormData,
): Promise<T> {
  const url = `https://api.telegram.org/bot${tokenOf(acct)}/${method}`;
  const form = body instanceof FormData;
  const res = await fetchRetry(url, {
    method: body ? "POST" : "GET",
    ...(body
      ? {
          headers: form ? {} : { "content-type": "application/json" },
          body: form ? body : JSON.stringify(body),
        }
      : {}),
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };
  if (!json.ok)
    throw new Error(
      `Telegram Bot API: ${json.description ?? `HTTP ${res.status}`}` +
        (/chat not found|bot was blocked|can't initiate/i.test(
          json.description ?? "",
        )
          ? " — a bot can only message chats it was let into; for DMs the user must press Start in the bot first."
          : ""),
    );
  return json.result as T;
}

/** getUpdates without consuming: no offset, so Telegram re-serves the same
 * window (~24h) and chats/history stay repeatable reads. */
async function updates(acct: ResolvedAccount): Promise<TgUpdate[]> {
  return botApi<TgUpdate[]>(acct, "getUpdates", { limit: 100 });
}

function chatLabel(c: NonNullable<TgUpdate["message"]>["chat"]): string {
  return c.title ?? c.username ?? c.first_name ?? String(c.id);
}

export async function botTest(acct: ResolvedAccount): Promise<ProtocolResult> {
  const me = await botApi<{ username?: string; first_name?: string }>(
    acct,
    "getMe",
  );
  return {
    ok: true,
    text: `Connected as @${me.username ?? me.first_name ?? "bot"}.`,
  };
}

export const botOps: ChatOps = {
  async chats(acct, opts) {
    const ups = await updates(acct);
    const seen = new Map<number, string>();
    for (const u of ups) {
      const c = u.message?.chat;
      if (c && !seen.has(c.id)) seen.set(c.id, `${c.id}  ${c.type}  ${chatLabel(c)}`);
    }
    const rows = [...seen.values()].slice(0, Math.max(opts.limit ?? 30, 1));
    return {
      ok: true,
      text: rows.length
        ? `Chats the bot has seen recently (via updates):\n${rows.join("\n")}\nA chat not listed can still be messaged by id or @username if the bot is in it.`
        : "No recent updates. The bot can still send to a chat id or @username it's a member of — for DMs, press Start in the bot first.",
    };
  },

  async topics() {
    return {
      ok: false,
      text: "",
      error:
        "Bots can't enumerate forum topics. Use the Telegram (account) connector for topics, or pass the topic id if you know it.",
    };
  },

  async history(acct, opts) {
    const ups = await updates(acct);
    const wanted = opts.chat.trim().toLowerCase();
    const rows = ups
      .filter((u) => {
        const c = u.message?.chat;
        if (!c) return false;
        return (
          String(c.id) === wanted ||
          c.username?.toLowerCase() === wanted.replace(/^@/, "") ||
          chatLabel(c).toLowerCase() === wanted
        );
      })
      .map((u) => {
        const m = u.message!;
        const who = m.from?.username ?? m.from?.first_name ?? "?";
        const at = new Date(m.date * 1000).toISOString().slice(0, 16).replace("T", " ");
        const media = m.document?.file_name
          ? ` [file: ${m.document.file_name}]`
          : m.photo
            ? " [photo]"
            : "";
        return `#${m.message_id}  ${at}  ${who}: ${m.text ?? m.caption ?? ""}${media}`.trimEnd();
      })
      .slice(-(opts.limit ?? 30));
    return {
      ok: true,
      text: rows.length
        ? `Messages sent TO the bot in ${opts.chat} (bots don't see other history):\n${rows.join("\n")}`
        : `No recent messages to the bot from ${opts.chat}. Bots only see messages addressed to them (or all, with privacy mode off).`,
    };
  },

  async send(acct, opts) {
    await botApi(acct, "sendMessage", {
      chat_id: opts.chat,
      text: opts.message,
      ...(opts.topic ? { message_thread_id: opts.topic } : {}),
    });
    return {
      ok: true,
      text: `Sent to ${opts.chat}${opts.topic ? ` (topic ${opts.topic})` : ""} as the bot.`,
    };
  },

  async sendFile(acct, opts, ctx: ConnectorContext) {
    if (/^https?:\/\//i.test(opts.file)) {
      // Telegram fetches URLs itself.
      await botApi(acct, "sendDocument", {
        chat_id: opts.chat,
        document: opts.file,
        ...(opts.caption ? { caption: opts.caption } : {}),
        ...(opts.topic ? { message_thread_id: opts.topic } : {}),
      });
      return { ok: true, text: `Sent ${opts.file} to ${opts.chat} as the bot.` };
    }
    const abs = ctx.files.resolveRead(opts.file);
    const { readFile } = await import("fs/promises");
    const data = await readFile(abs);
    const name = abs.split(/[/\\]/).pop() ?? "file";
    const mime = mimeOf(name);
    const photo = !opts.asDocument && mime.startsWith("image/");
    const form = new FormData();
    form.set("chat_id", opts.chat);
    if (opts.caption) form.set("caption", opts.caption);
    if (opts.topic) form.set("message_thread_id", String(opts.topic));
    form.set(
      photo ? "photo" : "document",
      new Blob([new Uint8Array(data)], { type: mime }),
      name,
    );
    await botApi(acct, photo ? "sendPhoto" : "sendDocument", form);
    return {
      ok: true,
      text: `Sent ${name} (${Math.round(data.length / 1024)}KB) to ${opts.chat} as the bot.`,
    };
  },

  async downloadMedia() {
    return {
      ok: false,
      text: "",
      error:
        "Not supported for bots here yet — use the Telegram (account) connector to download media.",
    };
  },
};
