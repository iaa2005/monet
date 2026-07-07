/**
 * Agent wrapper — TAOR (Think-Act-Observe-Respond) loop with tools.
 *
 * MVP: 7 tools (read_file, write_file, edit_file, grep, glob,
 * run_command, todo_write). Full vendor integration in v1.1.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { resolve, join, relative } from "path";
import type {
  LLMEvent,
  LLMMessage,
  LLMRequest,
  LLMTool,
} from "../llm/adapter.js";
import { getProviderManager } from "../provider/manager.js";
import { createAdapter } from "../llm/adapter.js";
import { getWorkspacePath } from "../ipc/workspace.js";

const execAsync = promisify(exec);

// ─── System prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Claude Code Desktop — a powerful AI coding assistant running as a desktop application.

## Capabilities
You have access to tools for reading, writing, and editing files, running shell commands, searching code with grep, finding files with glob patterns, and tracking tasks with a todo list.

## Tool Usage Guidelines
1. **Read before write**: always read a file before editing it
2. **Be precise**: when editing, provide exact old_string and new_string
3. **Explain**: briefly explain what you're doing before using tools
4. **Todo list**: for multi-step tasks, use todo_write to track progress
5. **Search efficiently**: use grep to find code patterns, glob for file patterns
6. **Commands**: prefer cross-platform commands, avoid OS-specific flags
7. **Paths**: use absolute or workspace-relative paths

## Response Style
- Be concise and direct
- Use markdown for code blocks with language tags
- Ask clarifying questions when needed
- After completing a task, summarize what was done`;

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
    description:
      "Create a new file or overwrite an existing file with new content.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write" },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Edit a file by replacing old_string with new_string. The old_string must match exactly once in the file.",
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
      "Search for a regex pattern in files. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: {
          type: "string",
          description:
            "Directory or file to search in (default: workspace root)",
        },
        include: {
          type: "string",
          description: 'File pattern to include, e.g. "*.ts"',
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description:
      "Find files matching a glob pattern. Returns relative file paths.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: 'Glob pattern, e.g. "**/*.ts", "src/**/*.tsx"',
        },
        path: {
          type: "string",
          description: "Directory to search in (default: workspace root)",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command and return stdout/stderr. Timeout: 30s, max output: 1MB.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: {
          type: "string",
          description: "Working directory (default: workspace root)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "todo_write",
    description:
      "Create and manage a task list for your current session. Use to track progress on multi-step tasks.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique identifier" },
              content: { type: "string", description: "Task description" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "done"],
                description: "Task status",
              },
            },
            required: ["id", "content", "status"],
          },
          description: "List of todo items",
        },
      },
      required: ["todos"],
    },
  },
];

// ─── Tool execution ─────────────────────────────────────────────────────

function resolvePath(inputPath: string): string {
  if (inputPath.startsWith("/") || /^[A-Z]:/i.test(inputPath)) {
    return inputPath;
  }
  return join(getWorkspacePath(), inputPath);
}

function globMatch(pattern: string, basePath: string): string[] {
  // Simple glob: support **, *, ?
  const results: string[] = [];

  function walk(dir: string, parts: string[]): void {
    if (parts.length === 0) {
      results.push(relative(basePath, dir));
      return;
    }

    const [head, ...rest] = parts;

    if (head === "**") {
      // Match everything recursively
      results.push(relative(basePath, dir));
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            walk(join(dir, entry.name), parts); // stay in **
            walk(join(dir, entry.name), rest); // consume **
          } else {
            walk(join(dir, entry.name), rest);
          }
        }
      } catch {
        /* skip inaccessible dirs */
      }
    } else {
      const regex = new RegExp(
        "^" + head.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      );
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (regex.test(entry.name)) {
            if (rest.length === 0) {
              results.push(relative(basePath, join(dir, entry.name)));
            } else if (entry.isDirectory()) {
              walk(join(dir, entry.name), rest);
            }
          }
        }
      } catch {
        /* skip */
      }
    }
  }

  const relPattern = relative(basePath, resolve(pattern));
  const parts = relPattern.split(/[/\\]/).filter(Boolean);
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
        if (lines.length > 500) {
          return `File: ${path} (${lines.length} lines, showing first 500)\n\n${lines.slice(0, 500).join("\n")}\n\n... (${lines.length - 500} more lines)`;
        }
        return `File: ${path} (${lines.length} lines)\n\n${content}`;
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : err}`;
      }
    }

    case "write_file": {
      const path = resolvePath(input.path as string);
      const content = input.content as string;
      try {
        writeFileSync(path, content, "utf-8");
        return `Successfully wrote ${content.split("\n").length} lines to ${path}`;
      } catch (err) {
        return `Error writing file: ${err instanceof Error ? err.message : err}`;
      }
    }

    case "edit_file": {
      const path = resolvePath(input.path as string);
      const oldStr = input.old_string as string;
      const newStr = input.new_string as string;

      if (!existsSync(path)) return `Error: File not found: ${path}`;

      try {
        const content = readFileSync(path, "utf-8");
        const index = content.indexOf(oldStr);

        if (index === -1) {
          return `Error: old_string not found in file. Make sure the string matches exactly (including whitespace).`;
        }

        if (content.indexOf(oldStr, index + 1) !== -1) {
          return `Error: old_string matches multiple locations. Make it more specific.`;
        }

        const newContent =
          content.slice(0, index) +
          newStr +
          content.slice(index + oldStr.length);
        writeFileSync(path, newContent, "utf-8");
        return `Successfully edited ${path}: replaced ${oldStr.length} chars with ${newStr.length} chars`;
      } catch (err) {
        return `Error editing file: ${err instanceof Error ? err.message : err}`;
      }
    }

    case "grep": {
      const pattern = input.pattern as string;
      const searchPath = input.path ? resolvePath(input.path as string) : ws;
      const include = input.include as string | undefined;

      try {
        const regex = new RegExp(pattern, "gi");
        const results: string[] = [];

        function search(dir: string): void {
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const full = join(dir, entry.name);

              if (entry.isDirectory()) {
                if (
                  !entry.name.startsWith(".") &&
                  entry.name !== "node_modules"
                ) {
                  search(full);
                }
                continue;
              }

              if (
                include &&
                !entry.name.match(
                  new RegExp(include.replace(/\*/g, ".*").replace(/\?/g, ".")),
                )
              ) {
                continue;
              }

              if (entry.name.startsWith(".")) continue;

              try {
                const content = readFileSync(full, "utf-8");
                const lines = content.split("\n");

                for (let i = 0; i < lines.length; i++) {
                  if (regex.test(lines[i])) {
                    const relPath = relative(ws, full);
                    results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
                    if (results.length >= 50) return;
                  }
                }
              } catch {
                /* skip binary/unreadable */
              }
            }
          } catch {
            /* skip */
          }
        }

        const stat = statSync(searchPath);
        if (stat.isFile()) {
          const content = readFileSync(searchPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length && results.length < 50; i++) {
            if (regex.test(lines[i])) {
              results.push(
                `${relative(ws, searchPath)}:${i + 1}: ${lines[i].trim()}`,
              );
            }
          }
        } else {
          search(searchPath);
        }

        if (results.length === 0) return "No matches found";
        return `Found ${results.length} match(es):\n${results.join("\n")}`;
      } catch (err) {
        return `Error in grep: ${err instanceof Error ? err.message : err}`;
      }
    }

    case "glob": {
      const pattern = input.pattern as string;
      const basePath = input.path ? resolvePath(input.path as string) : ws;

      try {
        const results = globMatch(pattern, basePath)
          .filter((f) => {
            try {
              return statSync(join(basePath, f)).isFile();
            } catch {
              return false;
            }
          })
          .slice(0, 100);

        if (results.length === 0) return "No files found";
        return `Found ${results.length} file(s):\n${results.join("\n")}`;
      } catch (err) {
        return `Error in glob: ${err instanceof Error ? err.message : err}`;
      }
    }

    case "run_command": {
      const command = input.command as string;
      const cwd = (input.cwd as string) ? resolvePath(input.cwd as string) : ws;

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        });
        const output = [stdout, stderr].filter(Boolean).join("\n");
        return output || "(no output)";
      } catch (err: unknown) {
        const execErr = err as {
          stdout?: string;
          stderr?: string;
          message: string;
        };
        return execErr.stderr || execErr.stdout || `Error: ${execErr.message}`;
      }
    }

    case "todo_write": {
      const todos = input.todos as Array<{
        id: string;
        content: string;
        status: string;
      }>;
      const statusIcons: Record<string, string> = {
        pending: "⬜",
        in_progress: "🔄",
        done: "✅",
      };
      const lines = todos.map(
        (t) => `${statusIcons[t.status] || "⬜"} [${t.status}] ${t.content}`,
      );
      return `Todo list:\n${lines.join("\n")}`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── Agent loop ─────────────────────────────────────────────────────────

export interface AgentRunOptions {
  systemPrompt?: string;
  maxTurns?: number;
  signal?: AbortSignal;
}

export async function runAgent(
  userMessage: string,
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
  const { systemPrompt = SYSTEM_PROMPT, maxTurns = 15, signal } = options;
  const messages: LLMMessage[] = [{ role: "user", content: userMessage }];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      onEvent({ type: "error", error: "Aborted by user" });
      return;
    }

    const toolCalls: {
      id: string;
      name: string;
      input: Record<string, unknown>;
    }[] = [];

    const request: LLMRequest = {
      model: provider.model,
      system: systemPrompt,
      messages,
      tools: TOOLS,
      max_tokens: 8192,
    };

    await adapter.stream(
      request,
      (event) => {
        if (event.type === "tool_use") {
          toolCalls.push({
            id: event.id,
            name: event.name,
            input: event.input,
          });
        }
        onEvent(event);
      },
      signal,
    );

    if (toolCalls.length === 0) return;

    // Add assistant message with tool calls
    messages.push({
      role: "assistant",
      content: toolCalls.map((tc) => ({
        type: "tool_use" as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      })),
    });

    // Execute tools and add results
    const results: Array<{ tool_use_id: string; content: string }> = [];
    for (const tc of toolCalls) {
      const result = await executeTool(tc.name, tc.input);
      results.push({ tool_use_id: tc.id, content: result });
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
