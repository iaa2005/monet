/**
 * Agent wrapper — TAOR loop with 7 tools + vendor-adapted system prompt.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import { resolve, join, relative } from "path";
import type {
  LLMEvent,
  LLMMessage,
  LLMContentBlock,
  LLMTool,
} from "../llm/adapter.js";
import { getProviderManager } from "../provider/manager.js";
import { createAdapter } from "../llm/adapter.js";
import { getWorkspacePath } from "../ipc/workspace.js";
import { getSystemPrompt } from "./prompts.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Run a shell command. On Windows we use PowerShell (so cmdlets like
 * Get-ChildItem work) and force UTF-8 output encoding so non-ASCII text isn't
 * mojibake; elsewhere we use the default shell.
 */
async function runShellCommand(
  command: string,
  cwd: string,
): Promise<string> {
  const opts = {
    cwd,
    timeout: 60000,
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
    encoding: "utf8" as const,
  };
  try {
    if (process.platform === "win32") {
      const wrapped =
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
        "$OutputEncoding=[System.Text.Encoding]::UTF8; " +
        command;
      const { stdout, stderr } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          wrapped,
        ],
        opts,
      );
      return [stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)";
    }
    const { stdout, stderr } = await execAsync(command, opts);
    return [stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)";
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return (e.stderr || e.stdout || `Error: ${e.message}`).trim() || "(error)";
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────

const TOOLS: LLMTool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file. Returns the full file content.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or workspace-relative path to the file",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create a new file or overwrite an existing file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Edit a file by replacing old_string with new_string. old_string must match exactly once.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Text to replace it with" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "grep",
    description:
      "Search for a regex pattern in files. Returns matching lines with paths.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: {
          type: "string",
          description: "Directory or file to search (default: workspace)",
        },
        include: { type: "string", description: 'File pattern e.g. "*.ts"' },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern. Returns relative paths.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: 'Glob pattern, e.g. "**/*.ts"',
        },
        path: { type: "string", description: "Directory (default: workspace)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command. On Windows this runs in PowerShell (use PowerShell syntax, e.g. Get-ChildItem). Timeout: 60s.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: {
          type: "string",
          description: "Working directory (default: workspace)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "todo_write",
    description: "Create and manage a task list for tracking progress.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "done"],
              },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
];

// ─── Tool execution ─────────────────────────────────────────────────────

function resolvePath(inputPath: string): string {
  if (inputPath.startsWith("/") || /^[A-Z]:/i.test(inputPath)) return inputPath;
  return join(getWorkspacePath(), inputPath);
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', 'dist', 'out', '.next', 'build'])
const MAX_SCAN = 5000

function globMatch(pattern: string, basePath: string): string[] {
  const results: string[] = []
  let scanned = 0
  function walk(dir: string, parts: string[]): void {
    if (results.length >= 100 || scanned > MAX_SCAN) return
    if (parts.length === 0) { results.push(relative(basePath, dir)); return }
    const [head, ...rest] = parts
    if (head === '**') {
      results.push(relative(basePath, dir))
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (SKIP_DIRS.has(e.name)) continue
          scanned++
          if (e.isDirectory()) { walk(join(dir, e.name), parts); walk(join(dir, e.name), rest) }
          else walk(join(dir, e.name), rest)
        }
      } catch { /* skip */ }
    } else {
      const regex = new RegExp('^' + head.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (SKIP_DIRS.has(e.name)) continue
          if (regex.test(e.name)) {
            if (rest.length === 0) results.push(relative(basePath, join(dir, e.name)))
            else if (e.isDirectory()) walk(join(dir, e.name), rest)
          }
        }
      } catch { /* skip */ }
    }
  }
  const parts = relative(basePath, resolve(pattern))
    .split(/[/\\]/)
    .filter(Boolean);
  if (parts.length === 0) parts.push("*");
  walk(basePath, parts);
  return results;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const ws = getWorkspacePath();
  switch (name) {
    case "read_file": {
      const path = resolvePath(input.path as string);
      if (!existsSync(path)) return `Error: File not found: ${path}`;
      try {
        const content = readFileSync(path, "utf-8");
        const lines = content.split("\n");
        return lines.length > 500
          ? `File: ${path} (${lines.length} lines, first 500)\n\n${lines.slice(0, 500).join("\n")}\n\n... (${lines.length - 500} more)`
          : `File: ${path} (${lines.length} lines)\n\n${content}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : err}`;
      }
    }
    case "write_file": {
      try {
        writeFileSync(
          resolvePath(input.path as string),
          input.content as string,
          "utf-8",
        );
        return `Wrote ${(input.content as string).split("\n").length} lines to ${input.path}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : err}`;
      }
    }
    case "edit_file": {
      const path = resolvePath(input.path as string);
      if (!existsSync(path)) return `Error: File not found: ${path}`;
      try {
        const content = readFileSync(path, "utf-8");
        const oldStr = input.old_string as string;
        const idx = content.indexOf(oldStr);
        if (idx === -1)
          return `Error: old_string not found. Match exactly (including whitespace).`;
        if (content.indexOf(oldStr, idx + 1) !== -1)
          return `Error: old_string matches multiple locations.`;
        const n =
          content.slice(0, idx) +
          (input.new_string as string) +
          content.slice(idx + oldStr.length);
        writeFileSync(path, n, "utf-8");
        return `Edited ${path}: ${oldStr.length} → ${(input.new_string as string).length} chars`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : err}`;
      }
    }
    case "grep": {
      try {
        const regex = new RegExp(input.pattern as string, "gi");
        const sp = input.path ? resolvePath(input.path as string) : ws;
        const inc = input.include
          ? new RegExp(
              (input.include as string)
                .replace(/\*/g, ".*")
                .replace(/\?/g, "."),
            )
          : null;
        const results: string[] = [];
        function search(dir: string): void {
          try {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
              const fp = join(dir, e.name);
              if (e.isDirectory()) {
                if (!e.name.startsWith(".") && e.name !== "node_modules")
                  search(fp);
                continue;
              }
              if (inc && !inc.test(e.name)) continue;
              if (e.name.startsWith(".")) continue;
              try {
                readFileSync(fp, "utf-8")
                  .split("\n")
                  .forEach((l, i) => {
                    if (regex.test(l) && results.length < 50)
                      results.push(`${relative(ws, fp)}:${i + 1}: ${l.trim()}`);
                  });
              } catch {
                /* binary */
              }
            }
          } catch {
            /* skip */
          }
        }
        if (statSync(sp).isFile()) {
          readFileSync(sp, "utf-8")
            .split("\n")
            .forEach((l, i) => {
              if (regex.test(l) && results.length < 50)
                results.push(`${relative(ws, sp)}:${i + 1}: ${l.trim()}`);
            });
        } else search(sp);
        return results.length
          ? `Found ${results.length}:\n${results.join("\n")}`
          : "No matches";
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : err}`;
      }
    }
    case "glob": {
      try {
        const bp = input.path ? resolvePath(input.path as string) : ws;
        const r = globMatch(input.pattern as string, bp)
          .filter((f) => {
            try {
              return statSync(join(bp, f)).isFile();
            } catch {
              return false;
            }
          })
          .slice(0, 100);
        return r.length
          ? `Found ${r.length}:\n${r.join("\n")}`
          : "No files found";
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : err}`;
      }
    }
    case "run_command": {
      const cwd = input.cwd ? resolvePath(input.cwd as string) : ws;
      return runShellCommand(input.command as string, cwd);
    }
    case "todo_write": {
      const todos = input.todos as Array<{
        id: string;
        content: string;
        status: string;
      }>;
      const icons: Record<string, string> = {
        pending: "⬜",
        in_progress: "🔄",
        done: "✅",
      };
      return `Todo:\n${todos.map((t) => `${icons[t.status] || "⬜"} [${t.status}] ${t.content}`).join("\n")}`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── Agent loop ─────────────────────────────────────────────────────────

export interface AgentRunOptions {
  maxTurns?: number;
  signal?: AbortSignal;
  /** Prepended to the system prompt (used by chat modes like Plan/Concise). */
  modeDirective?: string;
}

/**
 * Per-session conversation history kept in the proper multi-turn format
 * (assistant text + tool_use blocks, user tool_result blocks). This is what
 * makes the chat multi-turn: each send continues the same array.
 */
const conversations = new Map<string, LLMMessage[]>();

/** Drop a session's in-memory history (e.g. on "New session"). */
export function resetConversation(sessionId: string): void {
  conversations.delete(sessionId);
}

/**
 * Seed a session's history from previously persisted display messages so a
 * reopened chat can continue (text-only reconstruction of past turns).
 */
export function seedConversation(
  sessionId: string,
  priorText: { role: "user" | "assistant"; content: string }[],
): void {
  if (conversations.has(sessionId)) return;
  conversations.set(
    sessionId,
    priorText.filter((m) => m.content).map((m) => ({ ...m })),
  );
}

export async function runAgent(
  sessionId: string,
  userContent: string | LLMContentBlock[],
  onEvent: (event: LLMEvent) => void,
  options: AgentRunOptions = {},
): Promise<void> {
  const provider = getProviderManager().getActive();
  if (!provider) {
    onEvent({
      type: "error",
      error: "No active provider configured. Go to Settings to add one.",
    });
    return;
  }

  const adapter = createAdapter(provider);
  const basePrompt = await getSystemPrompt();
  const { maxTurns = 15, signal, modeDirective } = options;
  const systemPrompt = modeDirective
    ? `${modeDirective}\n\n${basePrompt}`
    : basePrompt;

  let messages = conversations.get(sessionId);
  if (!messages) {
    messages = [];
    conversations.set(sessionId, messages);
  }
  messages.push({ role: "user", content: userContent });

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      onEvent({ type: "error", error: "Aborted" });
      return;
    }

    const toolCalls: {
      id: string;
      name: string;
      input: Record<string, unknown>;
    }[] = [];
    let assistantText = "";

    await adapter.stream(
      {
        model: provider.model,
        system: systemPrompt,
        messages,
        tools: TOOLS,
        max_tokens: 8192,
      },
      (event) => {
        if (event.type === "text_delta") assistantText += event.text;
        if (event.type === "tool_use")
          toolCalls.push({
            id: event.id,
            name: event.name,
            input: event.input,
          });
        onEvent(event);
      },
      signal,
    );

    // Record the assistant turn (text + tool_use blocks) so the next turn
    // and the next user message have the full context.
    const assistantBlocks: LLMContentBlock[] = [];
    if (assistantText) assistantBlocks.push({ type: "text", text: assistantText });
    for (const tc of toolCalls)
      assistantBlocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    if (assistantBlocks.length > 0)
      messages.push({
        role: "assistant",
        content: assistantText && toolCalls.length === 0 ? assistantText : assistantBlocks,
      });

    onEvent({
      type: "message_stop",
      stop_reason: toolCalls.length ? "tool_use" : "end_turn",
    });

    if (toolCalls.length === 0) return;

    // Execute tools with progress events.
    const results: { tool_use_id: string; content: string }[] = [];
    for (const tc of toolCalls) {
      if (signal?.aborted) {
        onEvent({ type: "error", error: "Aborted" });
        return;
      }
      onEvent({ type: "tool_result", toolUseID: tc.id, toolName: tc.name, content: "Running..." });
      const content = await executeTool(tc.name, tc.input);
      onEvent({ type: "tool_result", toolUseID: tc.id, toolName: tc.name, content });
      results.push({ tool_use_id: tc.id, content });
    }

    messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
      })),
    });
  }
}
