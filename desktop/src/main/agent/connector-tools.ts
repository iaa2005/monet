/**
 * Connector tools — Mail / CloudFiles / Calendar / Telegram.
 *
 * One tool per PROTOCOL family, with an `action` discriminator, so connecting a
 * second mailbox adds an account rather than a tool: the model's schema budget
 * stays flat no matter how many services are wired up. Which accounts exist is
 * injected into each tool's description at build time, so the model knows what
 * it can address without a discovery call.
 *
 * All four are marked NOT read-only: they can send mail, post to Telegram,
 * write files and create events, so every call goes through the permission
 * prompt. That is deliberate — an agent emailing someone unprompted is exactly
 * the kind of action a user must approve.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import { accountHint, pickAccount } from "../connectors/index.js";
import {
  mailFolders,
  mailRead,
  mailSearch,
  mailSend,
} from "../connectors/protocols/mail.js";
import {
  filesDelete,
  filesList,
  filesMkdir,
  filesRead,
  filesWrite,
} from "../connectors/protocols/files.js";
import {
  calendarCreate,
  calendarEvents,
  calendarList,
  contactsList,
} from "../connectors/protocols/dav.js";
import {
  telegramChats,
  telegramHistory,
  telegramSend,
} from "../connectors/protocols/telegram.js";
import type { ProtocolResult } from "../connectors/types.js";
import { tunablePrompt } from "../prompts/index.js";

interface Output {
  text: string;
  isError: boolean;
}

function toOutput(r: ProtocolResult): { data: Output } {
  return {
    data: {
      text: r.error ? `${r.text}\n${r.error}`.trim() : r.text,
      isError: !r.ok,
    },
  };
}

function fail(e: unknown): { data: Output } {
  return {
    data: { text: e instanceof Error ? e.message : String(e), isError: true },
  };
}

function resultBlock(content: Output, toolUseID: string): ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseID,
    content: content.text,
    is_error: content.isError || undefined,
  };
}

// ─── Mail (IMAP + SMTP) ─────────────────────────────────────────────────────

const mailSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(["folders", "search", "read", "send"])
      .describe("What to do."),
    account: z
      .string()
      .optional()
      .describe("Which mailbox; optional when only one is connected."),
    folder: z.string().optional().describe("Mailbox folder. Default INBOX."),
    query: z
      .string()
      .optional()
      .describe(
        "search: Gmail query syntax on Gmail (from:x has:attachment), plain text elsewhere.",
      ),
    uid: z.number().optional().describe("read: the message uid from search."),
    to: z.string().optional().describe("send: recipient address."),
    cc: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional().describe("send: plain-text body."),
    limit: z.number().optional().describe("search: max messages. Default 20."),
  }),
);
type MailInput = ReturnType<typeof mailSchema>;

export const MailTool = buildTool({
  name: "Mail",
  searchHint: "read, search and send email over IMAP/SMTP",
  maxResultSizeChars: 60_000,
  get inputSchema(): MailInput {
    return mailSchema();
  },
  userFacingName() {
    return "Mail";
  },
  isReadOnly() {
    return false; // can send
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      tunablePrompt(
        "tool-mail",
        [
          "Read, search and send email through the user's connected mailboxes",
          "(IMAP/SMTP). Use search first to get a uid, then read that uid.",
          "On Gmail, query takes real Gmail search syntax. Never send mail the",
          "user did not ask for; quote what you will send before sending.",
        ].join(" "),
      ),
      `Connected mailboxes: ${accountHint("imap") || "(none)"}.`,
    ].join("\n");
  },
  async description() {
    return "Read, search and send email in the user's connected mailboxes.";
  },
  async call(input: z.infer<MailInput>, _context: ToolUseContext) {
    try {
      const acct = pickAccount(
        input.action === "send" ? "smtp" : "imap",
        input.account,
      );
      switch (input.action) {
        case "folders":
          return toOutput(await mailFolders(acct));
        case "search":
          return toOutput(
            await mailSearch(acct, {
              query: input.query,
              folder: input.folder,
              limit: input.limit,
            }),
          );
        case "read":
          if (input.uid == null)
            return fail(new Error("read needs a uid (get one from search)."));
          return toOutput(await mailRead(acct, { uid: input.uid, folder: input.folder }));
        case "send":
          if (!input.to || !input.subject || !input.body)
            return fail(new Error("send needs to, subject and body."));
          return toOutput(
            await mailSend(acct, {
              to: input.to,
              cc: input.cc,
              subject: input.subject,
              body: input.body,
            }),
          );
      }
    } catch (e) {
      return fail(e);
    }
  },
  mapToolResultToToolResultBlockParam: resultBlock,
  renderToolUseMessage() {
    return null;
  },
});

// ─── CloudFiles (WebDAV) ────────────────────────────────────────────────────

const filesSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(["list", "read", "write", "delete", "mkdir"]),
    account: z
      .string()
      .optional()
      .describe("Which drive; optional when only one is connected."),
    path: z.string().describe("Remote path, e.g. /Documents/notes.md"),
    content: z.string().optional().describe("write: file contents."),
  }),
);
type FilesInput = ReturnType<typeof filesSchema>;

export const CloudFilesTool = buildTool({
  name: "CloudFiles",
  searchHint: "list, read and write files on the user's cloud drive (WebDAV)",
  maxResultSizeChars: 60_000,
  get inputSchema(): FilesInput {
    return filesSchema();
  },
  userFacingName() {
    return "Cloud Files";
  },
  isReadOnly() {
    return false; // can write/delete
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      tunablePrompt(
        "tool-cloudfiles",
        [
          "Browse and edit files on the user's cloud drive over WebDAV (Yandex",
          "Disk, Nextcloud…). This is the user's real drive, not the sandbox —",
          "deleting or overwriting is not undoable, so confirm before you do.",
        ].join(" "),
      ),
      `Connected drives: ${accountHint("webdav") || "(none)"}.`,
    ].join("\n");
  },
  async description() {
    return "List, read and write files on the user's connected cloud drive.";
  },
  async call(input: z.infer<FilesInput>, _context: ToolUseContext) {
    try {
      const acct = pickAccount("webdav", input.account);
      switch (input.action) {
        case "list":
          return toOutput(await filesList(acct, { path: input.path }));
        case "read":
          return toOutput(await filesRead(acct, { path: input.path }));
        case "write":
          if (input.content == null)
            return fail(new Error("write needs content."));
          return toOutput(
            await filesWrite(acct, { path: input.path, content: input.content }),
          );
        case "delete":
          return toOutput(await filesDelete(acct, { path: input.path }));
        case "mkdir":
          return toOutput(await filesMkdir(acct, { path: input.path }));
      }
    } catch (e) {
      return fail(e);
    }
  },
  mapToolResultToToolResultBlockParam: resultBlock,
  renderToolUseMessage() {
    return null;
  },
});

// ─── Calendar (CalDAV + CardDAV) ────────────────────────────────────────────

const calSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(["calendars", "events", "create", "contacts"]),
    account: z.string().optional(),
    calendarUrl: z
      .string()
      .optional()
      .describe("From calendars; defaults to the first calendar."),
    days: z.number().optional().describe("events: window ahead. Default 7."),
    title: z.string().optional().describe("create: event title."),
    start: z
      .string()
      .optional()
      .describe("create: ISO datetime, e.g. 2026-07-20T14:00:00Z"),
    end: z.string().optional().describe("create: ISO datetime. Default +1h."),
    location: z.string().optional(),
    query: z.string().optional().describe("contacts: substring filter."),
    limit: z.number().optional(),
  }),
);
type CalInput = ReturnType<typeof calSchema>;

export const CalendarTool = buildTool({
  name: "Calendar",
  searchHint: "read and create calendar events, look up contacts (CalDAV/CardDAV)",
  maxResultSizeChars: 60_000,
  get inputSchema(): CalInput {
    return calSchema();
  },
  userFacingName() {
    return "Calendar";
  },
  isReadOnly() {
    return false; // can create events
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      tunablePrompt(
        "tool-calendar",
        [
          "Read and create events in the user's calendars (CalDAV) and look up",
          "contacts (CardDAV). Times are ISO 8601; prefer explicit UTC. Confirm",
          "before creating anything on a shared calendar.",
        ].join(" "),
      ),
      `Connected calendars: ${accountHint("caldav") || "(none)"}.`,
      `Connected contact books: ${accountHint("carddav") || "(none)"}.`,
    ].join("\n");
  },
  async description() {
    return "Read/create calendar events and look up contacts.";
  },
  async call(input: z.infer<CalInput>, _context: ToolUseContext) {
    try {
      if (input.action === "contacts") {
        const acct = pickAccount("carddav", input.account);
        return toOutput(
          await contactsList(acct, { query: input.query, limit: input.limit }),
        );
      }
      const acct = pickAccount("caldav", input.account);
      switch (input.action) {
        case "calendars":
          return toOutput(await calendarList(acct));
        case "events":
          return toOutput(
            await calendarEvents(acct, {
              calendarUrl: input.calendarUrl,
              days: input.days,
            }),
          );
        case "create":
          if (!input.title || !input.start)
            return fail(new Error("create needs title and start."));
          return toOutput(
            await calendarCreate(acct, {
              title: input.title,
              start: input.start,
              end: input.end,
              calendarUrl: input.calendarUrl,
              location: input.location,
            }),
          );
      }
    } catch (e) {
      return fail(e);
    }
  },
  mapToolResultToToolResultBlockParam: resultBlock,
  renderToolUseMessage() {
    return null;
  },
});

// ─── Telegram (MTProto) ─────────────────────────────────────────────────────

const tgSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(["chats", "history", "send"]),
    account: z.string().optional(),
    chat: z
      .string()
      .optional()
      .describe("Chat id or @username, from chats."),
    query: z.string().optional().describe("history: search within the chat."),
    message: z.string().optional().describe("send: message text."),
    limit: z.number().optional().describe("Default 30."),
  }),
);
type TgInput = ReturnType<typeof tgSchema>;

export const TelegramTool = buildTool({
  name: "Telegram",
  searchHint: "read and send Telegram messages from the user's account",
  maxResultSizeChars: 60_000,
  get inputSchema(): TgInput {
    return tgSchema();
  },
  userFacingName() {
    return "Telegram";
  },
  isReadOnly() {
    return false; // can send
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      tunablePrompt(
        "tool-telegram",
        [
          "Read, search and send Telegram messages as the user (MTProto — this",
          "is their personal account, not a bot). Messages you send appear as",
          "the user, so never send one they did not ask for; show the text",
          "first. Use chats to find a chat id, then history or send.",
        ].join(" "),
      ),
      `Connected accounts: ${accountHint("telegram") || "(none)"}.`,
    ].join("\n");
  },
  async description() {
    return "Read, search and send Telegram messages from the user's account.";
  },
  async call(input: z.infer<TgInput>, _context: ToolUseContext) {
    try {
      const acct = pickAccount("telegram", input.account);
      switch (input.action) {
        case "chats":
          return toOutput(await telegramChats(acct, { limit: input.limit }));
        case "history":
          if (!input.chat) return fail(new Error("history needs a chat."));
          return toOutput(
            await telegramHistory(acct, {
              chat: input.chat,
              limit: input.limit,
              query: input.query,
            }),
          );
        case "send":
          if (!input.chat || !input.message)
            return fail(new Error("send needs chat and message."));
          return toOutput(
            await telegramSend(acct, { chat: input.chat, message: input.message }),
          );
      }
    } catch (e) {
      return fail(e);
    }
  },
  mapToolResultToToolResultBlockParam: resultBlock,
  renderToolUseMessage() {
    return null;
  },
});

export const CONNECTOR_TOOLS = [
  MailTool,
  CloudFilesTool,
  CalendarTool,
  TelegramTool,
];
