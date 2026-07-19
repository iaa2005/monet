/**
 * TelegramBot — a BotFather bot over the plain HTTPS Bot API.
 *
 * The second way to speak Telegram, deliberately separate from account/:
 * no MTProto session to expire, just a token — which makes it the reliable
 * notification channel for routines. The trade is visibility: a bot only sees
 * chats it was let into, cannot DM a user until that user presses Start, and
 * cannot read arbitrary history (history here is the bot's own recent
 * updates). For the user's own chats, the Telegram account connector is the
 * right tool; promptHint keeps the model from confusing the two.
 */

import icon from "./icon.svg?raw";
import { botOps, botTest } from "./api.js";
import type { ConnectorService } from "../../types.js";

export const TelegramBot: ConnectorService = {
  id: "telegram-bot",
  name: "TelegramBot",
  displayName: "Telegram Bot",
  company: "Telegram",
  description: "Send messages and files as a bot; reliable for routines.",
  iconSvg: icon,
  auth: {
    kind: "token",
    field: {
      key: "password",
      label: "Bot token (from @BotFather)",
      secret: true,
      mono: true,
    },
  },
  credUrl: "https://t.me/BotFather",
  credLabel: "Open BotFather",
  note: "Create a bot with /newbot in @BotFather and paste its token. To let the bot message you, open the bot and press Start once — Telegram forbids bots from writing first. For groups/channels, add the bot as a member (admin for channels).",
  setupSteps: [
    { text: "Open @BotFather and send /newbot; copy the token it returns.", url: "https://t.me/BotFather", urlLabel: "BotFather" },
    { text: "Press Start in your new bot's chat — without that it cannot message you." },
    { text: "Optional: add the bot to a group or channel (admin rights to post in channels)." },
  ],
  capabilities: { chat: botOps },
  test: botTest,
  promptHint:
    "TelegramBot: sends AS THE BOT, not the user. Only sees chats it was added to. Use account='TelegramBot' when both are connected.",
};
