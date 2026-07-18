/**
 * Telegram — the company registry. Two ways to speak Telegram, two services:
 * account/ is the user's OWN account over MTProto (sees all their chats),
 * bot/ is a BotFather bot over the HTTPS Bot API (reliable notification
 * channel; only sees chats it was let into). Shared MTProto plumbing lives in
 * mtproto.ts beside them.
 */

import { Telegram } from "./account/index.js";
import { TelegramBot } from "./bot/index.js";
import type { ConnectorService } from "../types.js";

export const telegramServices: ConnectorService[] = [Telegram, TelegramBot];
