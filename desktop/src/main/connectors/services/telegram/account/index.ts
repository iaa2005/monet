/**
 * Telegram — MTProto against the user's OWN account (GramJS), not a bot: a bot
 * only ever sees chats it was added to. Sign-in is two IPC steps (send code →
 * confirm, +2FA password when set); the resulting StringSession is stored
 * encrypted and reused, and it is the thing that silently expires — which is
 * what the test proves alive.
 */

import icon from "./icon.svg?raw";
import { telegramOps } from "../mtproto.js";
import type { ConnectorService } from "../../types.js";

export const Telegram: ConnectorService = {
  id: "telegram-account",
  name: "TelegramAccount",
  displayName: "Telegram Account",
  company: "Telegram",
  description: "Your chats, channels and forum topics; send text and media.",
  iconSvg: icon,
  auth: { kind: "telegram" },
  credUrl: "https://my.telegram.org/apps",
  credLabel: "Get api_id + api_hash",
  note: "Sign in as yourself: create an app at my.telegram.org to get api_id/api_hash, then confirm the code Telegram sends you. Reads your own chats — a bot cannot.",
  capabilities: { chat: telegramOps },
  test: (acct) => telegramOps.chats(acct, { limit: 1 }),
  promptHint:
    "TelegramAccount: sends as the USER — never send without asking. Forum chats need a topic id. Use account='TelegramAccount' when both are connected.",
};
