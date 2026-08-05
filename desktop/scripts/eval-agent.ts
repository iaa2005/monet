/**
 * Prompt-eval harness — a real agent loop against the user's own provider,
 * built from the same leaf modules the app uses, so the system prompt (method
 * + discipline) under test is exactly the one the app ships.
 *
 * It deliberately does NOT import src/main/agent/index.ts (that pulls the sqlite
 * session store, which won't load under plain Node). The loop is a minimal
 * reimplementation: stream → collect tool_use → execute → tool_result → repeat.
 *
 * Isolation: the agent's workspace is pinned to ~/monet-eval and every tool
 * call runs under runWithCwdOverride, so Bash/Write land there and nowhere else.
 * Permission mode is bypass (no UI to prompt) — hence the hard cwd pin.
 *
 * Requires DEEPSEEK_API_KEY in the environment (the caller supplies it; it is
 * never read from the encrypted provider store and never printed).
 */

import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  executeVendorTool,
  getVendorApiTools,
  getVendorToolsForSpace,
} from "../src/main/agent/vendor-tools.js";
import { initVendorRuntime } from "../src/main/agent/vendor-context.js";
import { applyWorkspaceForRun } from "../src/main/ipc/workspace.js";
import { createAdapter } from "../src/main/llm/adapter.js";
import { tunablePrompt } from "../src/main/prompts/index.js";
import { getProfilePrompt } from "../src/main/app/profile.js";
import { buildMemoryPrompt } from "../src/main/memory/store.js";
import type {
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
} from "../src/main/llm/adapter.js";

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) {
  console.error("DEEPSEEK_API_KEY is not set in the environment.");
  process.exit(2);
}

const TASK = process.env.EVAL_TASK;
if (!TASK) {
  console.error("EVAL_TASK is not set.");
  process.exit(2);
}
const SPACE = (process.env.EVAL_SPACE as "home" | "code") || "code";
const MODEL = process.env.EVAL_MODEL || "deepseek-v4-pro";
const MAX_TURNS = Number(process.env.EVAL_MAX_TURNS || 24);

const evalDir = join(homedir(), "monet-eval");
mkdirSync(evalDir, { recursive: true });

const provider = {
  id: "eval-deepseek",
  name: "DeepSeek",
  kind: "deepseek",
  baseURL: "https://api.deepseek.com/anthropic",
  apiKey: KEY,
  model: MODEL,
  isActive: true,
  maxTokens: 8_000,
  contextLimit: 128_000,
  models: [],
} as unknown as LLMProvider;

// Pin the workspace before the runtime initialises off it.
applyWorkspaceForRun(evalDir);
initVendorRuntime();

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logPath = join(evalDir, `transcript-${SPACE}-${stamp}.md`);
function log(s: string): void {
  appendFileSync(logPath, s + "\n", "utf-8");
}

/** Mirror of buildSystemPrompt(), without importing index.ts. */
async function buildSystem(): Promise<string> {
  const { getSystemPrompt } = await import(
    "../src/vendor/leaked/constants/prompts.js"
  );
  const sections = await getSystemPrompt(
    getVendorToolsForSpace(SPACE),
    provider.model,
  );
  const base = sections.filter(Boolean).join("\n\n");
  const extra = [
    getProfilePrompt(),
    buildMemoryPrompt(),
    tunablePrompt("method", ""),
    tunablePrompt("discipline", ""),
    tunablePrompt("system-append", ""),
  ]
    .map((s) => s?.trim())
    .filter(Boolean);
  const body = extra.length ? `${base}\n\n${extra.join("\n\n")}` : base;
  // The app PREPENDS the home directive on a Home run (index.ts, "directives").
  // Without it a Home eval measures a prompt the app never sends — and the
  // model burns turns calling Read/Bash it was never given.
  const directive =
    SPACE === "home" ? tunablePrompt("home-directive", "").trim() : "";
  return directive ? `${directive}\n\n${body}` : body;
}

function blockText(content: string | LLMContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? `[result]` : ""))
    .join("");
}

async function main(): Promise<void> {
  const adapter = createAdapter(provider);
  // MUST be space-filtered: without it a Home run is advertised the Code
  // toolset, the model calls Read/Bash, the executor refuses them, and the run
  // measures the harness rather than the agent.
  const apiTools = await getVendorApiTools(SPACE);
  const system = await buildSystem();

  writeFileSync(
    logPath,
    // The advertised tool list is logged so a run can distinguish "the harness
    // offered the wrong toolset" from "the model invented a tool".
    `# Eval transcript\n\n- space: ${SPACE}\n- model: ${provider.model}\n- workspace: ${evalDir}\n- system prompt: ${system.length} chars\n- tools (${apiTools.length}): ${apiTools.map((t) => t.name).join(", ")}\n\n## Task\n\n${TASK}\n`,
    "utf-8",
  );

  const messages: LLMMessage[] = [{ role: "user", content: TASK }];
  const { runWithCwdOverride } = await import("../src/vendor/leaked/utils/cwd.js");

  let turns = 0;
  for (; turns < MAX_TURNS; turns++) {
    let text = "";
    let reasoning = "";
    const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
    let stopReason = "";

    await adapter.stream(
      { model: provider.model, system, messages, tools: apiTools, max_tokens: 8_000 },
      (ev) => {
        if (ev.type === "text_delta") text += ev.text;
        else if (ev.type === "reasoning_delta") reasoning += ev.text;
        else if (ev.type === "tool_use")
          toolUses.push({ id: ev.id, name: ev.name, input: ev.input });
        else if (ev.type === "message_stop") stopReason = ev.stop_reason;
        else if (ev.type === "error") text += `\n[stream error: ${ev.error}]`;
      },
    );

    log(`\n---\n\n### Assistant (turn ${turns + 1})\n`);
    if (reasoning.trim()) log(`<thinking>\n${reasoning.trim().slice(0, 4_000)}\n</thinking>\n`);
    if (text.trim()) log(text.trim());

    // Assemble the assistant message the way the API needs it back.
    const assistantBlocks: LLMContentBlock[] = [];
    if (text.trim()) assistantBlocks.push({ type: "text", text });
    for (const tu of toolUses)
      assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    messages.push({
      role: "assistant",
      content: assistantBlocks.length ? assistantBlocks : text || "(empty)",
    });

    if (toolUses.length === 0) {
      log(`\n_(stop: ${stopReason || "end"})_`);
      break;
    }

    const resultBlocks: LLMContentBlock[] = [];
    for (const tu of toolUses) {
      log(`\n**→ ${tu.name}** \`${JSON.stringify(tu.input).slice(0, 300)}\``);
      const res = await runWithCwdOverride(evalDir, () =>
        executeVendorTool({
          sessionId: "eval",
          toolUseID: tu.id,
          name: tu.name,
          input: tu.input,
          model: provider.model,
          permissionMode: "bypassPermissions",
          space: SPACE,
        }),
      );
      const out = res.content.slice(0, 1_500);
      log(`\n\`\`\`\n${out}${res.content.length > 1_500 ? "\n…(truncated)" : ""}\n\`\`\``);
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: res.content,
        is_error: res.isError,
      });
    }
    messages.push({ role: "user", content: resultBlocks });
  }

  log(`\n\n---\n\n_Finished after ${turns + 1} turn(s)._`);
  console.log(`TRANSCRIPT: ${logPath}`);
  console.log(`turns=${turns + 1} space=${SPACE}`);
  process.exitCode = 0;
}

void main().catch((e) => {
  console.error("eval harness failed:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
