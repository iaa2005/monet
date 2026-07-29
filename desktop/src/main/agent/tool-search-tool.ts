/**
 * ToolSearch (desktop-native, opt-in) — deferred tool loading.
 *
 * When enabled, MCP connector tools are not advertised upfront (they can be
 * many and verbose). The model calls ToolSearch with keywords (or
 * "select:name1,name2") to find the tools it needs; matches are recorded in the
 * per-session revealed set and advertised on the next turn, so they become
 * callable. This trades one round-trip for a smaller standing tool schema.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import { getMcpTools, connectorServerNames } from "../mcp/manager.js";
import { revealTools } from "./revealed-tools.js";
import { getToolSearchConfig } from "./toolsearch-config.js";
import { tunablePrompt } from "../prompts/index.js";

interface TextOutput {
  text: string;
  isError: boolean;
}

const mapResult = (
  content: TextOutput,
  toolUseID: string,
): ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: toolUseID,
  content: content.text,
  is_error: content.isError || undefined,
});

/**
 * The deferred catalog: MCP tools (everything advertised upfront is already
 * available, so it needn't be searched).
 *
 * Filtered by space, matching the tool list's own rule. In Home only
 * connector-backed servers are ever advertised — a hand-written server could be
 * a filesystem or shell server, which is the machine Home exists to keep out —
 * so without this filter ToolSearch would report loading a tool that Home then
 * refuses to advertise, and the model would be left calling a name that never
 * appears.
 */
function deferredCatalog(space?: string): {
  name: string;
  description: string;
  params: string[];
}[] {
  const allowed = space === "home" ? connectorServerNames() : null;
  return getMcpTools()
    .filter((t) => !allowed || allowed.has(t.serverName))
    .map((t) => ({
      name: t.fullName,
      description: t.description,
      params: Object.keys(t.inputSchema.properties ?? {}),
    }));
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z
      .string()
      .describe(
        'Keywords to match against tool names/descriptions, or "select:name1,name2" to load exact tools.',
      ),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const MAX_MATCHES = 8;

export const ToolSearchTool = buildTool({
  name: "ToolSearch",
  searchHint: "find and load tools that aren't advertised upfront",
  maxResultSizeChars: 20_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "Tool Search";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return tunablePrompt(
      "tool-search",
      [
        "Find and load tools that aren't advertised upfront (e.g. MCP connector",
        "tools, kept out of the standing toolset to save context). Search with",
        'keywords, or pass "select:name1,name2" to load exact tools by name. The',
        "matches become callable on your next turn — call ToolSearch first, then",
        "call the tool it reveals.",
      ].join(" "),
    );
  },
  async description() {
    return "Search for and load tools that aren't advertised upfront (e.g. MCP tools).";
  },
  async call({ query }: z.infer<InputSchema>, context: ToolUseContext) {
    if (!getToolSearchConfig().enabled)
      return { data: { text: "ToolSearch is disabled.", isError: true } };
    const sessionId = (context as { sessionId?: string }).sessionId || "default";
    const space = (context as { space?: string }).space;
    const catalog = deferredCatalog(space);
    if (catalog.length === 0)
      return {
        data: {
          text: "No searchable tools — no MCP connectors are currently connected.",
          isError: false,
        },
      };

    // "select:a,b" → load exact tools by name.
    const sel = /^select:(.+)$/i.exec(query.trim());
    let matches: typeof catalog;
    if (sel) {
      const wanted = new Set(
        sel[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      matches = catalog.filter((t) => wanted.has(t.name));
    } else {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      matches = catalog
        .map((t) => {
          const hay = `${t.name} ${t.description}`.toLowerCase();
          const score = terms.reduce(
            (n, term) => n + (hay.includes(term) ? 1 : 0),
            0,
          );
          return { t, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_MATCHES)
        .map((x) => x.t);
    }

    if (matches.length === 0)
      return {
        data: {
          text: `No tools match "${query}". ${catalog.length} tool(s) are available to search.`,
          isError: false,
        },
      };

    revealTools(
      sessionId,
      matches.map((t) => t.name),
    );
    const lines = matches.map(
      (t) =>
        `- ${t.name}: ${t.description}${t.params.length ? ` (params: ${t.params.join(", ")})` : ""}`,
    );
    return {
      data: {
        text: `Loaded ${matches.length} tool(s) — callable now:\n${lines.join("\n")}`,
        isError: false,
      },
    };
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});
