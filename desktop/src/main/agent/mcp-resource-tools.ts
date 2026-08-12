/**
 * MCP resource tools (desktop-native).
 *
 * MCP servers expose two things: tools (actions) and *resources* (readable
 * content addressed by URI — files, records, docs). The desktop already routes
 * tool calls via the manager; these two tools add resource discovery/read so a
 * connected server's data is reachable, not just its actions. Code-only: Home
 * has no MCP (connectors reach the machine and outside services).
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import { listMcpResources, readMcpResource } from "../mcp/manager.js";
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

// ─── ListMcpResources ──────────────────────────────────────────────────────

const listSchema = lazySchema(() => z.strictObject({}));
type ListSchema = ReturnType<typeof listSchema>;

export const ListMcpResourcesTool = buildTool({
  name: "ListMcpResources",
  searchHint: "list readable resources across connected MCP servers",
  maxResultSizeChars: 40_000,
  get inputSchema(): ListSchema {
    return listSchema();
  },
  userFacingName() {
    return "List MCP Resources";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return tunablePrompt(
      "tool-mcp-list-resources",
      "List the resources (readable content addressed by URI) exposed by connected MCP servers. Use ReadMcpResource with a server + uri from this list to read one.",
    );
  },
  async description() {
    return "List readable resources across connected MCP servers.";
  },
  async call(_input: z.infer<ListSchema>, _context: ToolUseContext) {
    const { resources, errors } = await listMcpResources();
    const lines: string[] = [];
    if (resources.length === 0) {
      lines.push("No MCP resources available from connected servers.");
    } else {
      for (const r of resources) {
        const bits = [`${r.server} :: ${r.uri}`];
        if (r.name) bits.push(r.name);
        if (r.mimeType) bits.push(`(${r.mimeType})`);
        lines.push(`- ${bits.join("  ")}`);
        if (r.description) lines.push(`    ${r.description}`);
      }
    }
    for (const e of errors) lines.push(`[error] ${e.server}: ${e.error}`);
    return { data: { text: lines.join("\n"), isError: false } };
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── ReadMcpResource ───────────────────────────────────────────────────────

const readSchema = lazySchema(() =>
  z.strictObject({
    server: z.string().describe("The MCP server name (as shown by ListMcpResources)."),
    uri: z.string().describe("The resource URI to read."),
  }),
);
type ReadSchema = ReturnType<typeof readSchema>;

export const ReadMcpResourceTool = buildTool({
  name: "ReadMcpResource",
  searchHint: "read one MCP resource by server + uri",
  maxResultSizeChars: 100_000,
  get inputSchema(): ReadSchema {
    return readSchema();
  },
  userFacingName() {
    return "Read MCP Resource";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return tunablePrompt(
      "tool-mcp-read-resource",
      "Read a single MCP resource by `server` and `uri` (from ListMcpResources). Text resources return their content; binary resources return a note (they aren't inlined).",
    );
  },
  async description() {
    return "Read one MCP resource by server + uri.";
  },
  async call({ server, uri }: z.infer<ReadSchema>, _context: ToolUseContext) {
    const { contents, error } = await readMcpResource(server, uri);
    if (error) return { data: { text: error, isError: true } };
    if (contents.length === 0)
      return { data: { text: "(resource returned no content)", isError: false } };
    const text = contents
      .map((c) => c.text ?? c.note ?? `[${c.mimeType ?? "unknown"}]`)
      .join("\n\n");
    return { data: { text, isError: false } };
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});
