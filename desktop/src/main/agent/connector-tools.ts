/**
 * Connector tools — Mail / CloudFiles / Calendar / Telegram.
 *
 * One tool per CAPABILITY family, with an `action` discriminator, so a new
 * service adds an account rather than a tool and the model's schema budget
 * stays flat. Every call dispatches to the account's service implementation
 * (`acct.service.capabilities.*`) — this file knows no service by name; adding
 * one to the registry is enough to route here.
 *
 * Permissions are per ACTION, not per tool: each call resolves its action id
 * ("mail.send") and runs the connector permission engine before dispatching —
 * account override → service default → class default (read=allow, write=ask,
 * destructive=ask). isReadOnly(input) is action-aware, so plan/auto modes see
 * reads as reads instead of blanket-blocking the whole tool.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import {
  accountHint,
  accountsWithCapability,
  getService,
  pickAccount,
} from "../connectors/index.js";
import {
  findAction,
  type ResolvedAccount,
  type ServiceCapabilities,
} from "../connectors/services/types.js";
import {
  gateConnectorAction,
  runContextOf,
} from "../connectors/lib/permissions.js";
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

/** Whether `<cap>.<action>` is a read — drives isReadOnly(input) so plan/auto
 * treat connector reads as reads. Unknown actions count as writes. */
function actionIsRead(cap: string, action?: string): boolean {
  return action
    ? findAction(`${cap}.${action}`)?.access === "read"
    : false;
}

/** Run the permission engine for one resolved call; null = proceed. */
async function gate(
  acct: ResolvedAccount,
  actionId: string,
  human: { summary: string; detail?: string },
  context: ToolUseContext,
): Promise<{ data: Output } | null> {
  const r = await gateConnectorAction(acct, actionId, human, runContextOf(context));
  return r.ok ? null : { data: { text: r.message, isError: true } };
}

/** Prompt hints contributed by CONNECTED services of the given caps — a
 * service's own guidance travels with it instead of living in tool text. */
function hintsFor(...caps: (keyof ServiceCapabilities)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cap of caps)
    for (const a of accountsWithCapability(cap)) {
      const s = getService(a.presetId);
      if (s?.promptHint && !seen.has(s.id)) {
        seen.add(s.id);
        out.push(s.promptHint);
      }
    }
  return out.join(" ");
}

// ─── Mail ───────────────────────────────────────────────────────────────────

const mailSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(["folders", "search", "read", "send"]).describe("What to do."),
    account: z
      .string()
      .optional()
      .describe("Which mailbox; optional when only one is connected."),
    folder: z.string().optional().describe("Mailbox folder. Default INBOX."),
    query: z.string().optional().describe("search: query text."),
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
  searchHint: "read, search and send email in the user's connected mailboxes",
  maxResultSizeChars: 60_000,
  get inputSchema(): MailInput {
    return mailSchema();
  },
  userFacingName() {
    return "Mail";
  },
  isReadOnly(input?: { action?: string }) {
    return actionIsRead("mail", input?.action);
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      tunablePrompt(
        "tool-mail",
        [
          "Read, search and send email through the user's connected mailboxes.",
          "Use search first to get a uid, then read that uid. Never send mail",
          "the user did not ask for; quote what you will send before sending.",
        ].join(" "),
      ),
      hintsFor("mail"),
      `Connected mailboxes: ${accountHint("mail") || "(none)"}.`,
    ]
      .filter(Boolean)
      .join("\n");
  },
  async description() {
    return "Read, search and send email in the user's connected mailboxes.";
  },
  async call(input: z.infer<MailInput>, context: ToolUseContext) {
    try {
      const acct = pickAccount("mail", input.account);
      const ops = acct.service.capabilities.mail;
      if (!ops) return fail(new Error("This connector has no mail capability."));
      const denied = await gate(
        acct,
        `mail.${input.action}`,
        input.action === "send"
          ? {
              summary: `Send email via ${acct.service.name}`,
              detail: `to ${input.to} — “${input.subject}”`,
            }
          : { summary: `${acct.service.name}: ${input.action}` },
        context,
      );
      if (denied) return denied;
      switch (input.action) {
        case "folders":
          return toOutput(await ops.folders(acct));
        case "search":
          return toOutput(
            await ops.search(acct, {
              query: input.query,
              folder: input.folder,
              limit: input.limit,
            }),
          );
        case "read":
          if (input.uid == null)
            return fail(new Error("read needs a uid (get one from search)."));
          return toOutput(
            await ops.read(acct, { uid: input.uid, folder: input.folder }),
          );
        case "send":
          if (!input.to || !input.subject || !input.body)
            return fail(new Error("send needs to, subject and body."));
          return toOutput(
            await ops.send(acct, {
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

// ─── CloudFiles ─────────────────────────────────────────────────────────────

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
  searchHint: "list, read and write files on the user's cloud drives",
  maxResultSizeChars: 60_000,
  get inputSchema(): FilesInput {
    return filesSchema();
  },
  userFacingName() {
    return "Cloud Files";
  },
  isReadOnly(input?: { action?: string }) {
    return actionIsRead("files", input?.action);
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      tunablePrompt(
        "tool-cloudfiles",
        [
          "Browse and edit files on the user's cloud drives, addressed by path",
          "whatever the backend. This is the user's real drive, not the sandbox",
          "— confirm before overwriting or deleting.",
        ].join(" "),
      ),
      hintsFor("files"),
      `Connected drives: ${accountHint("files") || "(none)"}.`,
    ]
      .filter(Boolean)
      .join("\n");
  },
  async description() {
    return "List, read and write files on the user's connected cloud drives.";
  },
  async call(input: z.infer<FilesInput>, context: ToolUseContext) {
    try {
      const acct = pickAccount("files", input.account);
      const ops = acct.service.capabilities.files;
      if (!ops) return fail(new Error("This connector has no files capability."));
      const denied = await gate(
        acct,
        `files.${input.action}`,
        {
          summary: `${acct.service.name}: ${input.action} ${input.path}`,
          detail: input.path,
        },
        context,
      );
      if (denied) return denied;
      switch (input.action) {
        case "list":
          return toOutput(await ops.list(acct, { path: input.path }));
        case "read":
          return toOutput(await ops.read(acct, { path: input.path }));
        case "write":
          if (input.content == null)
            return fail(new Error("write needs content."));
          return toOutput(
            await ops.write(acct, { path: input.path, content: input.content }),
          );
        case "delete":
          return toOutput(await ops.delete(acct, { path: input.path }));
        case "mkdir":
          return toOutput(await ops.mkdir(acct, { path: input.path }));
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

// ─── Calendar (events + contacts) ───────────────────────────────────────────

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
  searchHint: "read and create calendar events, look up contacts",
  maxResultSizeChars: 60_000,
  get inputSchema(): CalInput {
    return calSchema();
  },
  userFacingName() {
    return "Calendar";
  },
  isReadOnly(input?: { action?: string }) {
    // The one tool serving two capabilities: contacts.list is the read.
    return input?.action === "contacts" || actionIsRead("calendar", input?.action);
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      tunablePrompt(
        "tool-calendar",
        [
          "Read and create events in the user's calendars, and look up their",
          "contacts. Times are ISO 8601; prefer explicit UTC. Confirm before",
          "creating anything on a shared calendar.",
        ].join(" "),
      ),
      hintsFor("calendar", "contacts"),
      `Connected calendars: ${accountHint("calendar") || "(none)"}.`,
      `Connected contact books: ${accountHint("contacts") || "(none)"}.`,
    ]
      .filter(Boolean)
      .join("\n");
  },
  async description() {
    return "Read/create calendar events and look up contacts.";
  },
  async call(input: z.infer<CalInput>, context: ToolUseContext) {
    try {
      if (input.action === "contacts") {
        const acct = pickAccount("contacts", input.account);
        const ops = acct.service.capabilities.contacts;
        if (!ops)
          return fail(new Error("This connector has no contacts capability."));
        const denied = await gate(
          acct,
          "contacts.list",
          { summary: `${acct.service.name}: look up contacts` },
          context,
        );
        if (denied) return denied;
        return toOutput(
          await ops.list(acct, { query: input.query, limit: input.limit }),
        );
      }
      const acct = pickAccount("calendar", input.account);
      const ops = acct.service.capabilities.calendar;
      if (!ops)
        return fail(new Error("This connector has no calendar capability."));
      const denied = await gate(
        acct,
        `calendar.${input.action}`,
        input.action === "create"
          ? {
              summary: `Create event via ${acct.service.name}`,
              detail: `“${input.title}” at ${input.start}`,
            }
          : { summary: `${acct.service.name}: ${input.action}` },
        context,
      );
      if (denied) return denied;
      switch (input.action) {
        case "calendars":
          return toOutput(await ops.calendars(acct));
        case "events":
          return toOutput(
            await ops.events(acct, {
              calendarUrl: input.calendarUrl,
              days: input.days,
            }),
          );
        case "create":
          if (!input.title || !input.start)
            return fail(new Error("create needs title and start."));
          return toOutput(
            await ops.create(acct, {
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

// ─── Telegram (chat capability) ─────────────────────────────────────────────

const tgSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(["chats", "topics", "history", "send", "send_file"]),
    account: z.string().optional(),
    chat: z
      .string()
      .optional()
      .describe(
        "Chat id or @username, from chats. Works for DMs, groups and channels alike.",
      ),
    topic: z
      .number()
      .optional()
      .describe(
        "Forum topic id, from topics. Required to post into a forum group — without it the message lands in General.",
      ),
    query: z.string().optional().describe("history: search within the chat."),
    message: z.string().optional().describe("send: message text."),
    file: z
      .string()
      .optional()
      .describe(
        "send_file: a path or an https URL. In Home the path must be inside this chat's sandbox.",
      ),
    caption: z.string().optional().describe("send_file: caption for the media."),
    asDocument: z
      .boolean()
      .optional()
      .describe(
        "send_file: send as a plain file. Default false, so images and video arrive as photo/video.",
      ),
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
  isReadOnly(input?: { action?: string }) {
    return actionIsRead("chat", input?.action);
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      tunablePrompt(
        "tool-telegram",
        [
          "Read, search and send messages in the user's chats. Use chats to",
          "find a chat id, then history or send. send_file takes a path or an",
          "https URL and picks photo/video/document by extension; pass",
          "asDocument to force a plain file.",
        ].join(" "),
      ),
      hintsFor("chat"),
      `Connected accounts: ${accountHint("chat") || "(none)"}.`,
    ]
      .filter(Boolean)
      .join("\n");
  },
  async description() {
    return "Read, search and send Telegram messages from the user's account.";
  },
  async call(input: z.infer<TgInput>, context: ToolUseContext) {
    try {
      const acct = pickAccount("chat", input.account);
      const ops = acct.service.capabilities.chat;
      if (!ops) return fail(new Error("This connector has no chat capability."));
      const denied = await gate(
        acct,
        `chat.${input.action}`,
        input.action === "send"
          ? {
              summary: `Send Telegram message via ${acct.service.name}`,
              detail: `to ${input.chat}: “${(input.message ?? "").slice(0, 120)}”`,
            }
          : input.action === "send_file"
            ? {
                summary: `Send file via ${acct.service.name}`,
                detail: `${input.file} → ${input.chat}`,
              }
            : { summary: `${acct.service.name}: ${input.action}` },
        context,
      );
      if (denied) return denied;
      switch (input.action) {
        case "chats":
          return toOutput(await ops.chats(acct, { limit: input.limit }));
        case "topics":
          if (!input.chat) return fail(new Error("topics needs a chat."));
          return toOutput(
            await ops.topics(acct, { chat: input.chat, limit: input.limit }),
          );
        case "history":
          if (!input.chat) return fail(new Error("history needs a chat."));
          return toOutput(
            await ops.history(acct, {
              chat: input.chat,
              limit: input.limit,
              query: input.query,
              topic: input.topic,
            }),
          );
        case "send":
          if (!input.chat || !input.message)
            return fail(new Error("send needs chat and message."));
          return toOutput(
            await ops.send(acct, {
              chat: input.chat,
              message: input.message,
              topic: input.topic,
            }),
          );
        case "send_file":
          if (!input.chat || !input.file)
            return fail(new Error("send_file needs chat and file."));
          return toOutput(
            await ops.sendFile(acct, {
              chat: input.chat,
              file: input.file,
              caption: input.caption,
              topic: input.topic,
              asDocument: input.asDocument,
              // Space + session decide whether a path is fenced to the sandbox.
              space: (context as { space?: string }).space,
              sessionId: (context as { sessionId?: string }).sessionId,
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

export const CONNECTOR_TOOLS = [
  MailTool,
  CloudFilesTool,
  CalendarTool,
  TelegramTool,
];

/** Tools that exist only because a connector is configured — billed to
 * "Connectors" in the context breakdown, scoped per routine. */
export const CONNECTOR_TOOL_NAMES = new Set([
  "Mail",
  "CloudFiles",
  "Calendar",
  "Telegram",
]);

/** Which shared tool serves which capability. `mcp` is absent on purpose —
 * MCP-backed services are served by their own server, scoped by server name. */
const CAPABILITY_TOOL: Record<string, string> = {
  mail: "Mail",
  files: "CloudFiles",
  calendar: "Calendar",
  contacts: "Calendar",
  chat: "Telegram",
};

/** The connector tools a set of service ids implies — how a routine that
 * declares ["gmail", "notion"] gets Mail but not Telegram. */
export function connectorToolNames(serviceIds: string[]): Set<string> {
  const out = new Set<string>();
  for (const id of serviceIds) {
    const caps = getService(id)?.capabilities ?? {};
    for (const cap of Object.keys(caps)) {
      const tool = CAPABILITY_TOOL[cap];
      if (tool) out.add(tool);
    }
  }
  return out;
}

/** Whether a connector tool has any enabled account behind it — gates its
 * advertisement, so an empty Mail tool isn't schema tax. */
export function connectorToolHasAccounts(toolName: string): boolean {
  for (const [cap, tool] of Object.entries(CAPABILITY_TOOL))
    if (tool === toolName && accountsWithCapability(cap as never).length > 0)
      return true;
  return false;
}
