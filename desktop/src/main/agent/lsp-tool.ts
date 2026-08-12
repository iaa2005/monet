/**
 * LSP tool (desktop-native, opt-in) — code intelligence for Code mode.
 *
 * Answers definition / references / hover / document-symbol / diagnostics
 * queries by driving a real language server over LSP (see lsp/manager.ts).
 * Code-only (needs the workspace + real files) and off by default (needs the
 * server binaries installed). Positions are 1-based, matching what editors show.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { isAbsolute, resolve } from "path";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import { getWorkspacePath } from "../ipc/workspace.js";
import { lspQuery, type LspOperation } from "./lsp/manager.js";
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

const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .enum([
        "goToDefinition",
        "findReferences",
        "hover",
        "documentSymbol",
        "diagnostics",
      ])
      .describe("The LSP query to run."),
    filePath: z.string().describe("Path to the file (absolute, or relative to the workspace)."),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based line (required for goToDefinition/findReferences/hover)."),
    character: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based character (required for goToDefinition/findReferences/hover)."),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

export const LSPTool = buildTool({
  name: "LSP",
  searchHint: "code intelligence: definitions, references, hover, symbols, diagnostics",
  maxResultSizeChars: 40_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "LSP";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return tunablePrompt(
      "tool-lsp",
      [
        "Query a language server for code intelligence: `goToDefinition`,",
        "`findReferences`, `hover` (type/docs), `documentSymbol` (outline), and",
        "`diagnostics` (errors/warnings) for a file. Positions are 1-based (line",
        "and character, as shown in an editor); position ops need both. Prefer",
        "this over grep for 'where is X defined / used' on TS/JS, Python, Go,",
        "Rust and C/C++. Requires the matching language server to be installed.",
      ].join(" "),
    );
  },
  async description() {
    return "Code intelligence (definitions, references, hover, symbols, diagnostics) via a language server.";
  },
  async call(
    { operation, filePath, line, character }: z.infer<InputSchema>,
    _context: ToolUseContext,
  ) {
    const root = getWorkspacePath();
    const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath);
    try {
      const text = await lspQuery({
        operation: operation as LspOperation,
        root,
        file: abs,
        line,
        character,
      });
      return { data: { text, isError: false } };
    } catch (err) {
      return {
        data: {
          text: `LSP error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      };
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});
