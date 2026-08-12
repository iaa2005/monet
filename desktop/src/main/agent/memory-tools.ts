/**
 * SearchPastChats — lets the agent look up the user's previous conversations
 * (titles + metadata from the sessions DB). Gated by Settings → Memory →
 * "Search and reference chats".
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool } from "@vendor/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import { getSessionStore } from "../session/store.js";

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().describe("Words to look for in past chat titles."),
    limit: z.number().int().positive().max(25).optional(),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

interface Output {
  text: string;
  isError?: boolean;
}

export const SearchPastChatsTool = buildTool({
  name: "SearchPastChats",
  searchHint: "search the user's past conversations",
  maxResultSizeChars: 8_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "SearchPastChats";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return [
      "Search the user's PAST chats in this app by title keywords. Use it when",
      "the user references earlier work ('как в прошлый раз', 'that chat about…')",
      "to recover context. Returns titles, spaces and dates.",
    ].join("\n");
  },
  async description() {
    return "Search past conversations by title.";
  },
  async call({ query, limit }: z.infer<InputSchema>) {
    try {
      const hits = getSessionStore().search(query, limit ?? 10);
      if (hits.length === 0)
        return { data: { text: `No past chats matching "${query}".` } };
      const lines = hits.map(
        (s) =>
          `- "${s.title}" — ${s.space ?? "home"}, ${s.messageCount ?? "?"} messages, updated ${String(s.updatedAt).slice(0, 10)}`,
      );
      return {
        data: { text: `Past chats matching "${query}":\n${lines.join("\n")}` },
      };
    } catch (err) {
      return {
        data: {
          text: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      };
    }
  },
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      type: "tool_result",
      tool_use_id: toolUseID,
      content: content.text,
      ...(content.isError ? { is_error: true } : {}),
    };
  },
  renderToolUseMessage() {
    return null;
  },
});
