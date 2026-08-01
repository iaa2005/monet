/**
 * Agent loop — drives the REAL vendor (leaked Claude Code) tools through the
 * provider-agnostic LLM adapter layer.
 *
 * Tools, schemas, per-tool prompts, validation and permission checks all come
 * from vendor/leaked (see agent/vendor-tools.ts). The transport stays ours:
 * the adapter speaks Anthropic/OpenAI/DeepSeek and streams LLMEvents to the
 * renderer, so the UI is untouched.
 */

import type {
  LLMEvent,
  LLMMessage,
  LLMContentBlock,
  LLMUsage,
} from "../llm/adapter.js";
import { getProviderManager } from "../provider/manager.js";
import type { EffortLevel } from "../provider/types.js";
import { createAdapter } from "../llm/adapter.js";
import {
  getSystemPrompt as getFallbackSystemPrompt,
  getSubAgentPrompt,
} from "./prompts-vendor.js";
import { CONNECTOR_TOOL_NAMES } from "./connector-tools.js";
import { connectorServerNames } from "../mcp/manager.js";
import { getService } from "../connectors/services/registry.js";
import {
  executeVendorTool,
  getVendorApiTools,
  getVendorTools,
  getVendorToolsForSpace,
  deferredToolsDirective,
  deferredToolsPending,
  deferredServerLabel,
  toolConcurrencyLookup,
  clearSessionGrants,
  type RequestPermission,
  type UiPermissionMode,
} from "./vendor-tools.js";
import { planBatches, runBatches } from "./tool-batching.js";
import { activeGoalReminder, idleGoalNote } from "./goal/inject.js";
import {
  currentPlan,
  markCommentsSeen,
  unseenComments,
} from "../plan/store.js";
import {
  buildingPlanReminder,
  unseenCommentsReminder,
} from "../plan/inject.js";
import { loadGoal } from "./goal/store.js";
import {
  dropSessionContext,
  initVendorRuntime,
  setAppState,
} from "./vendor-context.js";
import { clearSessionMode } from "./session-mode.js";
import { drainBgResults } from "./bg-agents.js";
import { buildMemoryPrompt } from "../memory/store.js";
import { getProfilePrompt } from "../profile.js";
import { tunablePrompt } from "../prompts/index.js";
import {
  isCaveman,
  cavemanDirective,
  CAVEMAN_COMPACT_HINT,
  CAVEMAN_TURN_REMINDER,
} from "./caveman.js";
import { clearRevealedTools } from "./revealed-tools.js";
import { deferredLines } from "./deferred-inventory.js";
import { browserDirective } from "./browser-directive.js";
import { getToolSearchConfig } from "./toolsearch-config.js";
import {
  loadTranscriptWithMeta,
  replaceTranscript,
  clearTranscript,
  recordContextEvent,
} from "../transcript-store.js";
import type { AskUserFn } from "../ipc/ask-user.js";
import type { AskPlanApprovalFn } from "../ipc/plan.js";
import { resolveModel } from "../provider/routing.js";
import { recordFinish, recordStart, settleSession } from "../task-log.js";

/** Prepend finished background-agent reports to the user turn as context. */
function mergeBackgroundResults(
  notes: string[],
  content: string | LLMContentBlock[],
): string | LLMContentBlock[] {
  const prefix = notes.join("\n\n") + "\n\n";
  if (typeof content === "string") return prefix + content;
  return [{ type: "text", text: prefix }, ...content];
}
import {
  shouldCompact,
  compactMessages,
  compactionThreshold,
  estimateTokens,
} from "./compaction.js";
import {
  drainInjections,
  formatInjection,
  markRunning,
  markStopped,
} from "./injection.js";

// ─── System prompt ──────────────────────────────────────────────────────

/**
 * The real Claude Code system prompt (git/env-aware, CLAUDE.md/MEMORY.md,
 * per-tool guidance). Falls back to the local facade if the vendor prompt
 * builder trips over a CLI-only dependency at runtime.
 */
async function buildSystemPrompt(
  model: string,
  space?: string,
  sessionId?: string,
  includeMemory = true,
): Promise<string> {
  initVendorRuntime();
  try {
    const { getSystemPrompt } = await import("@vendor/constants/prompts.js");
    // Space-filtered: in Home the prompt must not even MENTION Bash/FileEdit —
    // a model that reads about a tool will try to call it. sessionId resolves the
    // chat's engine so RunCommand is listed only when this chat runs on Podman.
    const sections = await getSystemPrompt(
      getVendorToolsForSpace(space, sessionId),
      model,
    );
    const prompt = sections
      .filter(Boolean)
      .join("\n\n");
    if (prompt.trim().length > 0) return withUserMemory(prompt, includeMemory);
    throw new Error("vendor system prompt came back empty");
  } catch (err) {
    console.warn(
      "[agent] vendor getSystemPrompt failed, using fallback:",
      err instanceof Error ? err.message : err,
    );
    return withUserMemory(await getFallbackSystemPrompt(), includeMemory);
  }
}

/**
 * How to work a task, not just what not to do.
 *
 * The discipline block below is a list of prohibitions; a weak model obeys
 * those and still flails, because what separates strong work is the ORDER of
 * operations: ground truth before plan, cause before fix, evidence before
 * claim. These are the habits that make a smaller model behave like a careful
 * one. Kept short — it is paid on every turn. Tunable via prompts/method.md.
 */
const METHOD_DEFAULT = [
  "# Method (how to work a task)",
  "1. Ground truth first. Read the actual file, output or error before forming",
  "   a plan. Never propose a change to code you have not read.",
  "2. Cause before fix. When something fails, state WHY it fails before you",
  "   change anything. A fix you cannot explain is a guess.",
  "3. Sequence by risk. Do the uncertain, load-bearing part first — if it fails,",
  "   the rest of the plan changes. Leave cheap, reversible steps for last.",
  "4. One change at a time while debugging. Two at once makes the result",
  "   uninterpretable.",
  "5. Evidence, not inspection. Run it and quote the output. “Looks correct” is",
  "   not a result.",
  "6. Separate what you verified from what you assume. Claim only what you ran;",
  "   mark the rest as an assumption and name what would confirm it.",
  "7. If the evidence contradicts the request — the cause is elsewhere, the file",
  "   says otherwise, the approach cannot work — say so instead of proceeding.",
  "8. Stop at done. No adjacent cleanups, no speculative abstractions.",
].join("\n");

/** Hardening block, always applied. Spells out — in short imperative lines a
 * weak model (DeepSeek etc.) can follow — the git / pre-commit / edit discipline
 * that the vendor prompt only implies. Tunable via prompts/discipline.md. */
const DISCIPLINE_DEFAULT = [
  "# Working discipline (follow exactly)",
  "## Edits",
  "- ALWAYS read a file before you edit it. Never edit blind.",
  "- For an edit, provide the EXACT existing text as old_string (enough lines to",
  "  be unique). If an edit fails, re-read the file — do not guess.",
  "- Change only what the task needs. No drive-by refactors or reformatting.",
  "## Verify before you claim done",
  "- Before saying a task is complete, actually run it: the project's tests,",
  "  build, lint and/or a smoke test. State the result. If you could not run",
  "  them, say so explicitly.",
  "## Git (only when the user asked to commit/push)",
  "- NEVER run `git commit` until you have run the project's tests/build/lint or",
  "  a smoke test IN THIS SESSION and they passed. If none exist or you could",
  "  not run them, say so and ask before committing.",
  "- Run `git status` and `git diff` before staging. Stage only files you",
  "  changed — never `git add -A`/`git add .` blindly.",
  "- If on the default branch (main/master), create a branch before committing.",
  "- NEVER: force-push, `git reset --hard` or `git checkout --` on a dirty tree,",
  "  `commit --no-verify`/`--no-gpg-sign`, or amend an already-pushed commit —",
  "  unless the user explicitly asked. If a hook fails, fix the cause.",
  "## Commands & sandbox",
  "- Prefer the dedicated tool over an ad-hoc shell command when one exists.",
  "- Use the sandbox/RunCommand tools to run tests and checks before reporting",
  "  success — do not assume code works because it looks right.",
  "## When a tool keeps failing",
  "- READ the error. If it names a fix, do that. If it says retrying will not",
  "  help, believe it.",
  "- The SAME error twice means the approach is wrong, not that the call needs",
  "  a third attempt. Change something or stop.",
  "- Never install, reset or provision the app's own machinery (sandbox",
  "  engines, VMs, container machines, package managers) to get around an",
  "  error. That is the app's job and yours to report.",
  "- If a tool you need is unavailable, finish by TELLING THE USER what is",
  "  blocked, what you did produce, and what would unblock it. Never go quiet",
  "  with the work half-done.",
].join("\n");

/** The method / discipline blocks, exported so delegated runs (sub-agents)
 * inherit the same rules the main agent works under. */
export function agentMethodPrompt(): string {
  return tunablePrompt("method", METHOD_DEFAULT);
}
export function agentDisciplinePrompt(): string {
  return tunablePrompt("discipline", DISCIPLINE_DEFAULT);
}

/** Append the user's long-term memory files (Settings → Memory), the always-on
 * working-discipline block, a global user-tunable addendum, and — when caveman
 * mode is on — the terse-style directive. `system-append` is empty by default
 * and applies to BOTH the vendor and fallback prompts. */
function withUserMemory(prompt: string, includeMemory = true): string {
  try {
    const extra = [
      getProfilePrompt(),
      // The switch a routine flips: everything else here is style and
      // discipline, but THIS is the user's private notebook.
      includeMemory ? buildMemoryPrompt() : "",
      tunablePrompt("method", METHOD_DEFAULT),
      tunablePrompt("discipline", DISCIPLINE_DEFAULT),
      tunablePrompt("system-append", ""),
      isCaveman() ? cavemanDirective() : "",
    ]
      .map((s) => s?.trim())
      .filter(Boolean);
    return extra.length ? `${prompt}\n\n${extra.join("\n\n")}` : prompt;
  } catch {
    return prompt;
  }
}

/** Materialise EVERY tunable-prompt file under <dataDir>/prompts, so the
 * "edit prompts" folder is complete regardless of what happens to be enabled.
 *
 * The old version only touched prompts of ENABLED tools (getVendorApiTools
 * filters by isEnabled), so a user with no Telegram connector, LSP off, etc.
 * never saw tool-telegram.md / tool-lsp.md / tool-calendar.md and 9 others.
 * Here every tool's prompt() is called directly, gates bypassed. */
export async function seedTunablePrompts(): Promise<void> {
  try {
    // Non-tool prompt producers.
    await getFallbackSystemPrompt().catch(() => "");
    getSubAgentPrompt();
    buildMemoryPrompt();
    (await import("../memory/store.js")).memoryPreamble();
    getProfilePrompt();
    homeDirective();
    tunablePrompt("system-append", "");
    tunablePrompt("method", METHOD_DEFAULT);
    tunablePrompt("discipline", DISCIPLINE_DEFAULT);
    cavemanDirective();

    // Every tool's prompt(), enabled or not — call the tool directly so a
    // disabled/unconfigured tool still writes its editable file. The prompt
    // options carry what the vendor tools read; connector/sandbox tools ignore
    // the extras.
    const { getAllToolsForSeeding, toolPromptOptions } = await import(
      "./vendor-tools.js"
    );
    const opts = await toolPromptOptions();
    for (const tool of getAllToolsForSeeding()) {
      try {
        await tool.prompt(opts as never);
      } catch {
        /* a tool whose prompt needs live context — skip, non-fatal */
      }
    }
  } catch {
    /* best-effort */
  }
}

/** Plain-text tail of a session's conversation (for memory extraction):
 * user/assistant text only, tool blocks reduced to one-line markers. */
export function getConversationText(
  sessionId: string,
  maxChars = 8_000,
): string | null {
  const messages = conversations.get(sessionId);
  if (!messages || messages.length === 0) return null;
  const lines: string[] = [];
  for (const m of messages.slice(-14)) {
    if (typeof m.content === "string") {
      lines.push(`${m.role}: ${m.content}`);
      continue;
    }
    const chunks: string[] = [];
    for (const b of m.content) {
      if (b.type === "text") chunks.push(b.text);
      else if (b.type === "tool_use") chunks.push(`[tool: ${b.name}]`);
      else if (b.type === "tool_result") chunks.push(`[tool result]`);
    }
    if (chunks.length) lines.push(`${m.role}: ${chunks.join(" ")}`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

/** Prepended in Home so the model knows the ground rules of the space.
 * Tunable via <dataDir>/prompts/home-directive.md. */
const HOME_DIRECTIVE_DEFAULT = [
  "You are in HOME. Your default workspace is an ISOLATED sandbox — you have",
  "no direct access to the user's filesystem or shell. This chat has its OWN",
  "sandbox of files (user attachments + files you produce): SandboxList",
  "shows them (subfolders included), SandboxRead/SandboxWrite handle text files,",
  "and RunPython executes Python in the same directory — use it for computation,",
  "data analysis and binary documents (charts, docx, xlsx). Every file written",
  "there is attached to the conversation automatically. Only the tools",
  "explicitly provided to you (e.g. Browser or Computer Use, if enabled) reach",
  "outside this sandbox — do not assume any other system access.",
].join(" ");
const homeDirective = (): string =>
  tunablePrompt("home-directive", HOME_DIRECTIVE_DEFAULT);

// ─── Agent loop ─────────────────────────────────────────────────────────

export interface AgentRunOptions {
  maxTurns?: number;
  signal?: AbortSignal;
  /** Prepended to the system prompt (used by chat modes like Plan/Concise). */
  modeDirective?: string;
  /**
   * Permission level driving the tool gate (default: "default" = ask).
   *
   * A FUNCTION, so switching the mode mid-answer takes effect on the very next
   * tool call. It used to be a value captured when the message was sent, which
   * meant flipping to Bypass while the model was working changed nothing until
   * the next message — the user kept being asked, and reasonably read that as
   * the switch not working.
   */
  permissionMode?: UiPermissionMode | (() => UiPermissionMode);
  /** Called when a tool needs the user's approval (routes to the UI dialog). */
  requestPermission?: RequestPermission;
  /** Round-trips an AskUserQuestion to the renderer dialog. */
  askUser?: AskUserFn;
  /** Round-trips a plan for approval (ExitPlanMode tool). */
  askPlanApproval?: AskPlanApprovalFn;
  /** Pin this run to a provider+model (a routine that chose its own). */
  providerId?: string;
  modelOverride?: string;
  /** Workspace ("home" | "code") — selects the advertised toolset. */
  space?: string;
  /**
   * This run's working directory. The chat's own folder, resolved by the send
   * path from the session. Absent = fall back to the current global (Home has
   * no filesystem workspace). runAgent pins the whole run to it so concurrent
   * chats/routines can't move each other's cwd.
   */
  cwd?: string;
  /** Reasoning effort requested from the composer (absent = provider default). */
  effort?: EffortLevel;
  /** Restrict MCP tools to these connector/server names (routines scope). */
  connectors?: string[];
  /**
   * No human is watching this run (a routine firing on its schedule).
   *
   * NOT the same as permissionMode "bypassPermissions": a user who turned on
   * "Skip all approvals" is still sitting right there. Tools that need a person
   * — not merely a permission — must key off this instead.
   */
  unattended?: boolean;
  /** Connector action ids the routine's creator granted for unattended use
   * (e.g. ["chat.send"]). Only consulted when unattended. */
  connectorGrants?: string[];
  /** Include the user's long-term memory in the system prompt (default true).
   * A routine can turn it off — a nightly digest has no business reading, or
   * colouring itself with, personal memory. */
  memory?: boolean;
}

/**
 * Per-session conversation history kept in the proper multi-turn format
 * (assistant text + tool_use blocks, user tool_result blocks). This is what
 * makes the chat multi-turn: each send continues the same array.
 */
const conversations = new Map<string, LLMMessage[]>();

/** Drop a session's in-memory history AND its durable transcript/context log
 * (New session, or a rewind/edit that rebuilds the history from a truncation). */
export function resetConversation(sessionId: string): void {
  conversations.delete(sessionId);
  clearTranscript(sessionId);
  dropSessionContext(sessionId);
  clearSessionGrants(sessionId);
  clearRevealedTools(sessionId);
}

/** Transcript user-turn messages with NO display bubble — background-delivery
 * turns (deliverBackgroundResults sends an empty message that only carries a
 * finished sub-agent's report). Tracked by object identity so compaction and
 * truncation "forget" them for free; persisted via the transcript `hidden`
 * column so the tagging survives a reopen. Excluding them keeps the rewind
 * user-turn count aligned with the visible user bubbles. */
const hiddenTurns = new WeakSet<LLMMessage>();

/** Write the session's live model history through to the durable transcript. */
function persistTranscript(sessionId: string): void {
  const msgs = conversations.get(sessionId);
  if (msgs)
    replaceTranscript(
      sessionId,
      msgs,
      msgs.map((m) => hiddenTurns.has(m)),
    );
}

/**
 * Populate the in-memory history from the durable transcript when a reopened
 * chat isn't loaded this process — full fidelity (tool blocks included). No-op
 * once loaded. Deliberately does NOT reconstruct from the display messages: a
 * cleared transcript (after a rewind/reset) must fall through to the renderer's
 * explicitly-truncated `seed`, not the possibly-stale display rows.
 */
export async function ensureTranscriptLoaded(sessionId: string): Promise<void> {
  if (conversations.has(sessionId)) return;
  const { messages, hidden } = loadTranscriptWithMeta(sessionId);
  if (messages.length > 0) {
    conversations.set(sessionId, messages);
    messages.forEach((m, i) => {
      if (hidden[i]) hiddenTurns.add(m);
    });
  }
}

/** Text-only rebuild from the persisted display messages — for /compact on a
 * reopened chat that has neither in-process history nor a durable transcript
 * (old, un-migrated). Not used on the send path (which has the seed). */
async function seedFromDisplayMessages(sessionId: string): Promise<void> {
  if (conversations.has(sessionId)) return;
  try {
    const { getSessionStore } = await import("../session-store.js");
    const s = getSessionStore().get(sessionId);
    if (!s) return;
    const prior = s.messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    if (prior.length > 0) conversations.set(sessionId, prior);
  } catch {
    /* best-effort */
  }
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

/**
 * Compact a session's in-memory history on demand (e.g. before switching to a
 * model with a smaller context window). Returns the token estimates, or null
 * when there's nothing to compact / no provider.
 */
export async function compactSessionNow(
  sessionId: string,
): Promise<{ before: number; after: number } | null> {
  // Reopened chat with no in-process history yet — load the durable transcript,
  // then (old chats only) fall back to a text-only rebuild from display rows.
  await ensureTranscriptLoaded(sessionId);
  if (!conversations.has(sessionId)) await seedFromDisplayMessages(sessionId);
  const messages = conversations.get(sessionId);
  if (!messages || messages.length < 2) return null;
  const provider = getProviderManager().getActive();
  if (!provider) return null;
  const adapter = createAdapter(provider);
  const beforeSnapshot = messages.map((m) => ({ ...m }));
  const before = estimateTokens(messages);
  const compacted = await compactMessages({
    messages,
    adapter,
    model: provider.model,
    maxTokens: provider.maxTokens || 16000,
  });
  if (compacted !== messages) {
    messages.length = 0;
    messages.push(...compacted);
  }
  const after = estimateTokens(messages);
  // Record the compaction so it can be undone ("rewind through compact"):
  // the BEFORE snapshot restores the pre-compaction context.
  if (after < before)
    recordContextEvent(sessionId, "compact", {
      manual: true,
      beforeTokens: before,
      afterTokens: after,
      before: beforeSnapshot,
      after: messages.map((m) => ({ ...m })),
    });
  persistTranscript(sessionId);
  return { before, after };
}

/**
 * Undo a compaction: restore the pre-compaction transcript from the event's
 * `before` snapshot, and drop that event (and any later ones — they no longer
 * describe the live history). Returns the restored/current token counts.
 */
/** Whether a transcript message begins a real, VISIBLE user turn (a prompt with
 * a display bubble) — not a tool_result continuation of the assistant turn, and
 * not a hidden background-delivery turn. This is what the renderer counts as a
 * user bubble, so rewind's user-turn index stays exact. */
function isUserTurnBoundary(m: LLMMessage): boolean {
  if (m.role !== "user" || hiddenTurns.has(m)) return false;
  if (typeof m.content === "string") return true;
  return m.content.some((b) => b.type !== "tool_result");
}

/** A user turn is "empty" (no real prompt) when it carries no text/media — it
 * exists only to deliver a background sub-agent's report. */
function isEmptyUserContent(content: string | LLMContentBlock[]): boolean {
  if (typeof content === "string") return content.trim() === "";
  return !content.some(
    (b) =>
      (b.type === "text" && b.text.trim() !== "") ||
      b.type === "image" ||
      b.type === "audio" ||
      b.type === "document" ||
      b.type === "video",
  );
}

/**
 * Full-fidelity rewind: truncate the durable transcript to the first
 * `keepUserTurns` user turns — keeping their assistant/tool continuations
 * (tool_use/tool_result blocks intact), instead of the old reset + reseed-as-
 * text. A chat with no durable transcript (old, un-migrated) falls back to a
 * clear so the renderer's already-truncated text `seed` applies on the next
 * send. Returns which fidelity was used.
 */
/**
 * Copy a session's full-fidelity transcript into a NEW session.
 *
 * This is what makes a fork a real fork. The renderer already copied the
 * display messages, but those are the text-only surface; without this the
 * forked chat re-seeds the model from bubbles, and every tool call and result
 * from the original — the context that made the conversation worth branching —
 * is gone. Claude Code forks by rewriting the transcript under a new id; same
 * move here.
 *
 * Read from the DB, not from the in-memory conversation: the DB carries the
 * hidden flags (background-delivery turns), and forking is only offered while
 * the session is idle, so the DB is current.
 *
 * `keepUserTurns` cuts at a user-turn boundary for "branch from here"; the
 * same divergence check as rewind applies — a compacted transcript's turn
 * indexes cannot be trusted, so the fork falls back to text fidelity.
 */
export async function forkTranscriptToSession(
  fromSessionId: string,
  toSessionId: string,
  keepUserTurns?: number,
  totalUserTurns?: number,
): Promise<{ fidelity: "full" | "text" }> {
  const { messages, hidden } = loadTranscriptWithMeta(fromSessionId);
  if (messages.length === 0) return { fidelity: "text" };

  const hiddenSet = new Set(messages.filter((_m, i) => hidden[i]));
  const isBoundary = (m: LLMMessage): boolean => {
    if (m.role !== "user" || hiddenSet.has(m)) return false;
    if (typeof m.content === "string") return true;
    return m.content.some((b) => b.type !== "tool_result");
  };

  let cut = messages.length;
  if (keepUserTurns != null) {
    const boundaries = messages.filter(isBoundary).length;
    if (totalUserTurns != null && boundaries !== totalUserTurns)
      return { fidelity: "text" };
    let seen = 0;
    for (let i = 0; i < messages.length; i++) {
      if (isBoundary(messages[i])) {
        if (seen === keepUserTurns) {
          cut = i;
          break;
        }
        seen++;
      }
    }
  }

  const copy = messages.slice(0, cut);
  replaceTranscript(toSessionId, copy, hidden.slice(0, cut));

  // The checkpoints come too. The copied messages carry checkpointSha values
  // that name commits in the ORIGINAL chat's shadow repo — without the repo,
  // every Rewind in the fork answers "no checkpoints exist for this chat",
  // which reads as Rewind being broken. A shadow store is a plain directory
  // of git objects; copying it makes those shas resolvable under the new id.
  try {
    const { shadowDir } = await import("./checkpoints.js");
    const { cpSync, existsSync } = await import("fs");
    const from = shadowDir(fromSessionId);
    const to = shadowDir(toSessionId);
    if (existsSync(from) && !existsSync(to))
      cpSync(from, to, { recursive: true });
  } catch (err) {
    console.error(
      "[fork] checkpoint store copy failed:",
      err instanceof Error ? err.message : err,
    );
  }
  return { fidelity: "full" };
}

export async function rewindTranscriptToUserTurn(
  sessionId: string,
  keepUserTurns: number,
  totalUserTurns?: number,
): Promise<{ fidelity: "full" | "text"; removed: number }> {
  await ensureTranscriptLoaded(sessionId);
  const msgs = conversations.get(sessionId);
  if (!msgs || msgs.length === 0) {
    resetConversation(sessionId);
    return { fidelity: "text", removed: 0 };
  }
  const boundaries = msgs.filter(isUserTurnBoundary).length;
  // If the transcript's visible user turns don't match the display's, it has
  // diverged (a compaction folded turns into a summary), so the turn INDEX
  // can't be trusted — fall back to the safe clear + renderer text seed.
  if (totalUserTurns != null && boundaries !== totalUserTurns) {
    resetConversation(sessionId);
    return { fidelity: "text", removed: 0 };
  }
  let seen = 0;
  let cut = msgs.length;
  for (let i = 0; i < msgs.length; i++) {
    if (isUserTurnBoundary(msgs[i])) {
      if (seen === keepUserTurns) {
        cut = i;
        break;
      }
      seen++;
    }
  }
  const removed = msgs.length - cut;
  msgs.length = cut; // truncate in place — keeps the conversations Map ref
  persistTranscript(sessionId);
  if (removed > 0)
    recordContextEvent(sessionId, "rewind", { keepUserTurns, removed });
  // Discarded turns leave stale derived state.
  lastUsageBySession.delete(sessionId);
  dropSessionContext(sessionId);
  clearRevealedTools(sessionId);
  return { fidelity: "full", removed };
}

/**
 * How many prompts can still be taken back.
 *
 * The visible user turns in the CURRENT context — which is the honest number.
 * Compaction replaces the history with a summary plus a recent tail, so turns
 * from before it are already gone from the model's view even though their
 * bubbles are still on screen. Kimi Code states the same limit ("prompts
 * before the last compaction cannot be undone"); here it falls out of counting
 * what is actually there rather than needing a special case.
 */
export async function undoableTurnCount(sessionId: string): Promise<number> {
  await ensureTranscriptLoaded(sessionId);
  const msgs = conversations.get(sessionId);
  if (!msgs) return 0;
  return msgs.filter(isUserTurnBoundary).length;
}

/**
 * Drop the last `count` prompts from the model's context.
 *
 * Deliberately NOT a rewind: files are left exactly as they are. The two
 * operations answer different questions — "undo what the agent DID" is the
 * checkpoint rewind, this is "forget that we discussed it", for when a
 * detour has filled the window with material that turned out to be noise.
 *
 * The todo list and any plan-mode override go with them, because both were
 * produced by the turns being removed and would otherwise describe work the
 * model can no longer see.
 */
export async function undoPrompts(
  sessionId: string,
  count = 1,
): Promise<{ removed: number; turnsLeft: number; messagesDropped: number }> {
  const available = await undoableTurnCount(sessionId);
  const removed = Math.max(0, Math.min(count, available));
  if (removed === 0) return { removed: 0, turnsLeft: available, messagesDropped: 0 };

  const keep = available - removed;
  const before = conversations.get(sessionId)?.length ?? 0;
  const result = await rewindTranscriptToUserTurn(sessionId, keep, available);
  const after = conversations.get(sessionId)?.length ?? 0;

  // State those turns produced. A todo list describing work the model can no
  // longer see is worse than no list, and a plan-mode override outliving the
  // plan it approved is how a "just planning" session starts editing files.
  try {
    setAppState((prev) => ({
      ...prev,
      todos: { ...prev.todos, [sessionId]: [] },
    }));
  } catch {
    /* no vendor state yet — nothing to clear */
  }
  clearSessionMode(sessionId);

  recordContextEvent(sessionId, "rewind", {
    undo: true,
    removedTurns: removed,
    fidelity: result.fidelity,
  });

  return { removed, turnsLeft: keep, messagesDropped: Math.max(0, before - after) };
}

export async function undoCompaction(
  sessionId: string,
  eventId: string,
): Promise<{ restored: number } | null> {
  const { getContextEvent, dropContextEventsFrom } = await import(
    "../transcript-store.js"
  );
  const ev = getContextEvent(sessionId, eventId);
  if (!ev || ev.type !== "compact") return null;
  const before = ev.payload.before as LLMMessage[] | undefined;
  if (!Array.isArray(before) || before.length === 0) return null;
  conversations.set(
    sessionId,
    before.map((m) => ({ ...m })),
  );
  persistTranscript(sessionId);
  dropContextEventsFrom(sessionId, ev.seq);
  return { restored: estimateTokens(before) };
}

/** Rough input-token estimate of a session's in-memory history. */
export function estimateSessionTokens(sessionId: string): number {
  const messages = conversations.get(sessionId);
  return messages ? estimateTokens(messages) : 0;
}

export interface ContextCategory {
  key: string;
  label: string;
  tokens: number;
  /** Optional drill-down: the individual entries that make up this category
   * (e.g. each tool, each MCP server, each skill). Estimated like the parent. */
  items?: { label: string; tokens: number }[];
}
export interface ContextBreakdown {
  budget: number;
  used: number;
  free: number;
  categories: ContextCategory[];
  /** Actual token usage from the last API response for this session, when the
   * agent has run at least one turn in this process. Null for cold/old chats.
   * When present, `used` is measured (not estimated). */
  apiUsage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  } | null;
}

/** Last API usage seen per session, captured from message_stop in runAgent.
 * Lets computeContextBreakdown report the REAL context total (input + cache)
 * instead of a chars/4 estimate once a turn has completed. Process-lived. */
const lastUsageBySession = new Map<string, LLMUsage>();

/**
 * Input+output tokens the session's last turn actually cost, for the goal
 * budget. Zero when no turn has run in this process — a budget that counted
 * unknown usage as a large number would stop a goal that had spent nothing.
 */
export function lastTurnTokens(sessionId: string): number {
  const u = lastUsageBySession.get(sessionId);
  if (!u) return 0;
  return (
    u.input_tokens +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    u.output_tokens
  );
}

/**
 * Estimate what currently fills the model's context window, by category — the
 * same pieces runAgent sends (system prompt, tool schemas, conversation). Token
 * counts are rough (chars/4), matching estimateTokens; the point is the mix,
 * not exact accounting. Best-effort: a partial breakdown still renders.
 */
export async function computeContextBreakdown(
  sessionId: string,
  space?: string,
  messageTokensOverride?: number,
): Promise<ContextBreakdown> {
  const provider = getProviderManager().getActive();
  const budget = provider?.inputLimit ?? provider?.contextLimit ?? 200_000;
  // Prefer the renderer's estimate (it always has the visible history, even for
  // old chats never run in this process); fall back to the in-memory run.
  const messageTokens =
    messageTokensOverride ?? estimateTokens(conversations.get(sessionId) ?? []);

  let systemTokens = 0;
  let toolTokens = 0;
  let mcpToolTokens = 0;
  let connectorTokens = 0;
  let skillTokens = 0;
  let memoryTokens = 0;
  // Per-item drill-down (each tool, each MCP server, each skill, each memory src).
  const toolItems: { label: string; tokens: number }[] = [];
  const mcpByServer = new Map<string, number>();
  // Connectors are billed apart from both: they're the user's own accounts, and
  // they come in two shapes — our protocol tools (Mail…) and an MCP server the
  // connector supplies (Notion…). Grouped per connector, not per shape.
  const connectorByName = new Map<string, number>();
  let skillItems: { label: string; tokens: number }[] = [];
  let memoryItems: { label: string; tokens: number }[] = [];
  try {
    const [apiTools, basePrompt] = await Promise.all([
      getVendorApiTools(space, sessionId),
      provider
        ? buildSystemPrompt(provider.model, space, sessionId)
        : Promise.resolve(""),
    ]);
    // Same directives the run builds, so the meter bills what is actually sent.
    const directives = [
      ...(space === "home" ? [homeDirective()] : []),
      deferredToolsDirective(space, sessionId),
      browserDirective(),
    ].filter(Boolean);
    const systemPrompt = [...directives, basePrompt]
      .filter(Boolean)
      .join("\n\n");
    let systemTotal = Math.ceil(systemPrompt.length / 4);

    const connectorServers = connectorServerNames();
    const connectorLabel = (id: string): string =>
      getService(id)?.name ?? id;

    // Deferred MCP tools cost nothing in the tool schema — that is the point —
    // so a connector whose tools are all deferred used to vanish from this
    // breakdown entirely, reading as "not attached" next to an MCP tools row of
    // 0. What it actually costs is its line in the deferred directive, which
    // lives inside the system prompt. Carve those lines out and bill each to
    // its own server, the same way skills and memory are carved out below, so
    // the categories stay mutually exclusive and an attached connector is
    // visible at its true (small) price.
    for (const { server, line } of deferredLines(
      deferredToolsPending(space, sessionId),
      deferredServerLabel,
    )) {
      const size = Math.ceil((line.length + 1) / 4);
      systemTotal -= size;
      if (connectorServers.has(server)) {
        connectorTokens += size;
        const label = connectorLabel(server);
        connectorByName.set(label, (connectorByName.get(label) ?? 0) + size);
      } else {
        mcpToolTokens += size;
        mcpByServer.set(server, (mcpByServer.get(server) ?? 0) + size);
      }
    }
    for (const t of apiTools) {
      const size = Math.ceil(JSON.stringify(t).length / 4);
      if (t.name.startsWith("mcp__")) {
        // mcp__<server>__<tool> → group by server for the drill-down.
        const server = t.name.split("__")[1] || "mcp";
        if (connectorServers.has(server)) {
          connectorTokens += size;
          const label = connectorLabel(server);
          connectorByName.set(label, (connectorByName.get(label) ?? 0) + size);
        } else {
          mcpToolTokens += size;
          mcpByServer.set(server, (mcpByServer.get(server) ?? 0) + size);
        }
      } else if (CONNECTOR_TOOL_NAMES.has(t.name)) {
        connectorTokens += size;
        connectorByName.set(t.name, (connectorByName.get(t.name) ?? 0) + size);
      } else {
        toolTokens += size;
        toolItems.push({ label: t.name, tokens: size });
      }
    }

    // Skills (the Skill tool's catalog) and memory (CLAUDE.md) both live INSIDE
    // the system prompt, so estimate each and carve them out of it — this keeps
    // the categories mutually exclusive and the total honest.
    try {
      const { listSkillInfos } = await import("../ipc/skills.js");
      skillItems = listSkillInfos().map((s) => ({
        label: s.name,
        tokens: Math.ceil((s.name.length + s.description.length + 12) / 4),
      }));
      skillTokens = skillItems.reduce((n, s) => n + s.tokens, 0);
    } catch {
      /* ignore */
    }
    // "Memory files" isn't just CLAUDE.md — it's every long-term-context block
    // withUserMemory() folds into basePrompt: the user Profile, the Settings →
    // Memory facts, and (Code only) the workspace CLAUDE.md. All three live
    // inside systemTotal, so carving them out here keeps System vs Memory honest
    // AND makes the popover show WHAT memory is made of instead of a flat 0.
    try {
      const { loadClaudeMd } = await import("../claude-md.js");
      const { getWorkspacePath } = await import("../ipc/workspace.js");
      const md = space === "home" ? null : loadClaudeMd(getWorkspacePath());
      const tok = (s: string | null): number => (s ? Math.ceil(s.length / 4) : 0);
      memoryItems = [
        { label: "Profile", tokens: tok(getProfilePrompt()) },
        { label: "User memory", tokens: tok(buildMemoryPrompt()) },
        { label: "Project memory (MONET.md)", tokens: tok(md) },
      ].filter((i) => i.tokens > 0);
      memoryTokens = memoryItems.reduce((n, i) => n + i.tokens, 0);
    } catch {
      /* ignore */
    }
    skillTokens = Math.min(skillTokens, systemTotal);
    memoryTokens = Math.min(memoryTokens, systemTotal - skillTokens);
    systemTokens = systemTotal - skillTokens - memoryTokens;
  } catch {
    /* best-effort */
  }

  const estimatedSum =
    messageTokens +
    systemTokens +
    toolTokens +
    mcpToolTokens +
    connectorTokens +
    skillTokens +
    memoryTokens;

  // Real usage (input + cache) once a turn has run this process; else estimate.
  const usage = lastUsageBySession.get(sessionId);
  const apiUsed = usage
    ? usage.input_tokens +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)
    : undefined;
  // The measured total usually exceeds our chars/4 estimate (exact tokenizer,
  // tool preamble, cache framing). Surface that gap as its own line so the
  // categories still sum to `used` and the bar stays consistent.
  const overhead = apiUsed != null ? Math.max(0, apiUsed - estimatedSum) : 0;
  const used = estimatedSum + overhead;
  const free = Math.max(0, budget - used);

  const sortItems = (
    xs: { label: string; tokens: number }[],
  ): { label: string; tokens: number }[] =>
    xs.filter((x) => x.tokens > 0).sort((a, b) => b.tokens - a.tokens);

  const mcpItems = sortItems(
    [...mcpByServer].map(([label, tokens]) => ({ label, tokens })),
  );

  const categories: ContextCategory[] = [
    { key: "messages", label: "Messages", tokens: messageTokens },
    { key: "system", label: "System prompt", tokens: systemTokens },
    {
      key: "tools",
      label: "System tools",
      tokens: toolTokens,
      items: sortItems(toolItems),
    },
    {
      key: "connectors",
      label: "Connectors",
      tokens: connectorTokens,
      items: sortItems(
        [...connectorByName].map(([label, tokens]) => ({ label, tokens })),
      ),
    },
    {
      key: "mcp",
      label: "MCP tools",
      tokens: mcpToolTokens,
      items: mcpItems,
    },
    {
      key: "skills",
      label: "Skills",
      tokens: skillTokens,
      items: sortItems(skillItems),
    },
    {
      key: "memory",
      label: "Memory files",
      tokens: memoryTokens,
      items: sortItems(memoryItems),
    },
    ...(overhead > 0
      ? [{ key: "overhead", label: "Measured overhead", tokens: overhead }]
      : []),
    { key: "free", label: "Free space", tokens: free },
  ];
  return {
    budget,
    used,
    free,
    categories,
    apiUsage: usage
      ? {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        }
      : null,
  };
}

/** Working directory the cached env prompt section was last built for. */
let lastPromptCwd: string | null = null;

export async function runAgent(
  sessionId: string,
  userContent: string | LLMContentBlock[],
  onEvent: (event: LLMEvent) => void,
  options: AgentRunOptions = {},
): Promise<void> {
  // This run OWNS its working directory. An explicit cwd (the chat's own folder,
  // resolved from the session by the send path) wins; else fall back to the
  // current global. Applying it keeps desktop-side reads (checkpoints, CLAUDE.md,
  // the vendor state sync in initVendorRuntime) consistent, and the vendor's
  // runWithCwdOverride pins the cwd for the prompt AND every tool call — so a
  // concurrent chat or a routine firing mid-stream can't move it out from under
  // this run. All the actual work lives in runAgentScoped.
  const { runWithCwdOverride } = await import("@vendor/utils/cwd.js");
  const { applyWorkspaceForRun, getWorkspacePath } = await import(
    "../ipc/workspace.js"
  );
  if (options.cwd) applyWorkspaceForRun(options.cwd);
  const runCwd = options.cwd ?? getWorkspacePath();

  // The vendor caches system-prompt sections by name for the life of the
  // process, and "env_info_simple" carries the working directory. In the CLI
  // that is safe — one process, one cwd — but here the directory changes when
  // the user switches workspace or a run pins its own. Left cached, the prompt
  // keeps announcing the FIRST directory while the tools work in the current
  // one: verified by asking the model, which read a stale path out of its
  // prompt and sent sub-agents to the wrong folder.
  if (lastPromptCwd !== runCwd) {
    try {
      const { getSystemPromptSectionCache } = await import(
        "@vendor/bootstrap/state.js"
      );
      getSystemPromptSectionCache().delete("env_info_simple");
    } catch {
      /* worst case the prompt keeps a stale path — don't fail the run */
    }
    lastPromptCwd = runCwd;
  }

  // Only a running session can take a mid-turn injection, and anything still
  // undelivered when this returns is dropped rather than carried into the
  // next turn — see injection.ts.
  markRunning(sessionId);
  try {
    return await runWithCwdOverride(runCwd, () =>
      runAgentScoped(sessionId, userContent, onEvent, options),
    );
  } finally {
    markStopped(sessionId);
    // Whatever ended this run — done, aborted, threw — any tool row still open
    // will never get a result. Settling here rather than at each of the five
    // message_stop sites means a new exit path cannot forget to do it, and a
    // thrown error settles too.
    settleSession(sessionId);
  }
}

async function runAgentScoped(
  sessionId: string,
  userContent: string | LLMContentBlock[],
  onEvent: (event: LLMEvent) => void,
  options: AgentRunOptions = {},
): Promise<void> {
  // A routine may pin its own model; everything else uses the active provider.
  const resolved = resolveModel(options.providerId, options.modelOverride);
  const provider = resolved?.provider;
  if (!provider) {
    onEvent({
      type: "error",
      error: "No active provider configured. Go to Settings to add one.",
    });
    return;
  }

  // The pinned model, or the provider's own default. Everything downstream —
  // the system prompt, each request, tool execution — must use THIS, not
  // provider.model, or a routine's pin would be silently ignored.
  const runModel = resolved.model;
  const adapter = createAdapter(provider);
  const {
    maxTurns = 40,
    signal,
    modeDirective,
    permissionMode: permissionModeOption = "default",
    requestPermission,
    askUser,
    askPlanApproval,
    space,
    effort,
    connectors,
    unattended,
    memory,
  } = options;

  let tools;
  let basePrompt;
  try {
    [tools, basePrompt] = await Promise.all([
      getVendorApiTools(space, sessionId, connectors),
      buildSystemPrompt(runModel, space, sessionId, memory !== false),
    ]);
  } catch (err) {
    onEvent({
      type: "error",
      error: `Agent init failed: ${err instanceof Error ? err.message : err}`,
    });
    onEvent({ type: "message_stop", stop_reason: "error" });
    return;
  }

  const directives = [
    ...(space === "home" ? [homeDirective()] : []),
    ...(modeDirective ? [modeDirective] : []),
    // What ToolSearch is holding back. Without this the model cannot tell a
    // deferred capability from an absent one, and answers as if it were absent.
    deferredToolsDirective(space, sessionId),
    // What is already open, and which dev servers are already running.
    browserDirective(),
  ].filter(Boolean);
  const systemPrompt =
    directives.length > 0
      ? `${directives.join("\n\n")}\n\n${basePrompt}`
      : basePrompt;

  // Full-fidelity continuation: load the durable transcript (tool blocks and
  // all) for a reopened chat before we build on it. No-op if already loaded.
  await ensureTranscriptLoaded(sessionId);
  let messages = conversations.get(sessionId);
  if (!messages) {
    messages = [];
    conversations.set(sessionId, messages);
  }
  // Fold any finished background sub-agent reports into this user turn so the
  // model can act on them. Done at the turn boundary (not when they finish) to
  // keep user/assistant alternation intact.
  const bgResults = drainBgResults(sessionId);
  // A turn that carries ONLY a background report (no user prompt/attachments)
  // has no display bubble — mark it hidden so rewind's turn count stays aligned.
  const hiddenTurn = bgResults.length > 0 && isEmptyUserContent(userContent);
  let turnContent =
    bgResults.length > 0
      ? mergeBackgroundResults(bgResults, userContent)
      : userContent;

  // Goal mode: restate the objective at every turn boundary. Once, at the
  // start, is not enough — twenty turns later it would be the oldest thing in
  // the context and the first casualty of a compaction. The objective travels
  // inside an <untrusted_objective> envelope; see goal/inject.ts for why.
  const activeGoal = loadGoal(sessionId);
  if (activeGoal) {
    const note =
      activeGoal.status === "active"
        ? activeGoalReminder(activeGoal)
        : idleGoalNote(activeGoal);
    turnContent = mergeBackgroundResults([note], turnContent);
  }

  // The plan document, same treatment as the goal: while it builds, the live
  // todo list is restated so the model keeps it truthful with UpdatePlan; any
  // user comments left on the document since last turn are handed over ONCE,
  // wrapped as data (see plan/inject.ts).
  const activePlan = currentPlan(sessionId);
  if (activePlan) {
    const notes: string[] = [];
    if (activePlan.status === "building")
      notes.push(buildingPlanReminder(activePlan));
    const freshComments = unseenComments(activePlan);
    const commentNote = unseenCommentsReminder(activePlan, freshComments);
    if (commentNote) {
      notes.push(commentNote);
      markCommentsSeen(
        activePlan.id,
        freshComments.map((c) => c.id),
      );
    }
    if (notes.length) turnContent = mergeBackgroundResults(notes, turnContent);
  }

  const userMsg: LLMMessage = { role: "user", content: turnContent };
  messages.push(userMsg);
  if (hiddenTurn) hiddenTurns.add(userMsg);
  persistTranscript(sessionId);

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      onEvent({ type: "error", error: "Aborted" });
      onEvent({ type: "message_stop", stop_reason: "abort" });
      return;
    }

    // ToolSearch (opt-in): re-resolve the toolset so tools the model revealed
    // last turn become callable this turn. Skip turn 0 (the pre-loop build
    // already covers it) and the whole thing when ToolSearch is disabled.
    if (turn > 0 && getToolSearchConfig().enabled) {
      try {
        tools = await getVendorApiTools(space, sessionId, connectors);
      } catch {
        /* keep the previous toolset on failure */
      }
    }

    // Auto-compaction: if the running history would overflow the context
    // window, summarize it and continue from the summary. Best-effort — on
    // failure compactMessages() returns the history unchanged. Mutate in
    // place so the per-session conversations Map keeps the same array ref.
    // Budget comes from the active model: max input tokens if set, else its
    // context length (resolved by the provider manager).
    // Caveman mode squeezes context earlier (60% of the normal trigger) and
    // asks for a tighter summary.
    const cave = isCaveman();
    const threshold = compactionThreshold({
      inputLimit: provider.inputLimit,
      contextLimit: provider.contextLimit,
      outputReserve: provider.maxTokens || 16000,
    });
    if (shouldCompact(messages, cave ? Math.floor(threshold * 0.6) : threshold)) {
      const beforeSnapshot = messages.map((m) => ({ ...m }));
      const beforeTokens = estimateTokens(messages);
      const compacted = await compactMessages({
        messages,
        adapter,
        model: runModel,
        maxTokens: provider.maxTokens || 16000,
        signal,
        terseHint: cave ? CAVEMAN_COMPACT_HINT : undefined,
        // Lets compaction stop after the lossless pass when that already fits.
        threshold: cave ? Math.floor(threshold * 0.6) : threshold,
      });
      if (compacted !== messages) {
        messages.length = 0;
        messages.push(...compacted);
        // Log the auto-compaction with a BEFORE snapshot so it can be undone
        // (rewind through compact → restore the pre-compaction context).
        recordContextEvent(sessionId, "compact", {
          manual: false,
          beforeTokens,
          afterTokens: estimateTokens(messages),
          before: beforeSnapshot,
          after: messages.map((m) => ({ ...m })),
        });
        persistTranscript(sessionId);
      }
    }

    const toolCalls: {
      id: string;
      name: string;
      input: Record<string, unknown>;
    }[] = [];
    let assistantText = "";
    let streamError: string | null = null;
    let lastUsage: LLMUsage | undefined;
    let lastStopReason: string | undefined;

    // Caveman reinforcement rides at the TAIL of the message list, not only in
    // the system prompt: adherence to a style rule decays with distance, and
    // the system prompt is thousands of tokens behind by the time the model
    // writes. Rebuilt per turn and never persisted into `messages`, so it can't
    // accumulate in the transcript or leak into compaction.
    const turnMessages = cave
      ? [
          ...messages,
          { role: "user" as const, content: CAVEMAN_TURN_REMINDER },
        ]
      : messages;

    try {
      await adapter.stream(
        {
          model: runModel,
          system: systemPrompt,
          messages: turnMessages,
          tools,
          max_tokens: provider.maxTokens || 16000,
          temperature: provider.temperature,
          effort: provider.supportsEffort ? effort : undefined,
          routing: provider.routing,
        },
        (event) => {
          if (event.type === "text_delta") assistantText += event.text;
          if (event.type === "tool_use")
            toolCalls.push({
              id: event.id,
              name: event.name,
              input: event.input,
            });
          if (event.type === "error") streamError = event.error;
          // Suppress the PER-TURN message_stop: in an agentic run each tool-use
          // turn's stream ends with a message_stop, but the task isn't done —
          // forwarding it would flip the UI to "finished" between turns (spinner
          // vanishes while tools run). The loop emits ONE authoritative
          // message_stop when the task truly ends (no tool calls / error /
          // abort). Keep the usage from the latest turn for that final event.
          if (event.type === "message_stop") {
            lastUsage = event.usage;
            lastStopReason = event.stop_reason;
            return;
          }
          // Durable task log. Recorded HERE rather than in the renderer store:
          // a tool call happens whether or not a window is listening, and the
          // agent keeps running across a renderer reload — a renderer-owned log
          // would lose exactly the executions worth looking up afterwards.
          if (event.type === "tool_use")
            recordStart({
              id: event.id,
              sessionId,
              tool: event.name,
              input: event.input ?? {},
            });
          onEvent(event);
        },
        signal,
      );
    } catch (err) {
      streamError = err instanceof Error ? err.message : "Stream error";
      onEvent({ type: "error", error: streamError });
      // Stream crashed — tell frontend we're done.
      onEvent({ type: "message_stop", stop_reason: "error" });
      return;
    }

    // Remember this turn's real token usage so the context meter can report the
    // measured total (input + cache) instead of a chars/4 estimate.
    if (lastUsage) lastUsageBySession.set(sessionId, lastUsage);

    // Record the assistant turn (text + tool_use blocks) so the next turn
    // and the next user message have the full context.
    const assistantBlocks: LLMContentBlock[] = [];
    if (assistantText)
      assistantBlocks.push({ type: "text", text: assistantText });
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
        content:
          assistantText && toolCalls.length === 0
            ? assistantText
            : assistantBlocks,
      });

    if (toolCalls.length === 0) {
      // The model is done — unless the user said something while it worked.
      // Deliver that as a new user message and keep going, rather than ending
      // the turn and making them press send on a correction they already
      // typed. This is the ONLY natural end of a run, so it is also the last
      // chance to deliver.
      const lateNotes = drainInjections(sessionId);
      if (lateNotes.length > 0) {
        const text = formatInjection(lateNotes);
        messages.push({ role: "user", content: text });
        for (const note of lateNotes)
          onEvent({ type: "user_message", content: note });
        persistTranscript(sessionId);
        continue;
      }
      // Durable, full-fidelity history for a clean reopen / continuation.
      persistTranscript(sessionId);
      onEvent({
        type: "message_stop",
        // Propagate the turn's real stop_reason (message_delta): the renderer
        // flags max_tokens so a silently truncated reply is visible.
        stop_reason: lastStopReason ?? "end_turn",
        usage: lastUsage,
      });
      // Code Rewind: snapshot the workspace AFTER the reply is done (never
      // blocks it) so this turn can be restored later. Home has no workspace.
      // getCwd() (not the global) so the snapshot is taken in THIS run's folder.
      if (space && space !== "home") {
        try {
          const { getCwd } = await import("@vendor/utils/cwd.js");
          const { snapshotWorkspace } = await import("./checkpoints.js");
          const sha = await snapshotWorkspace(sessionId, getCwd());
          if (sha) onEvent({ type: "checkpoint", sha });
        } catch {
          /* best-effort */
        }
      }
      return;
    }

    // Execute tools through the vendor pipeline with progress events.
    //
    // Calls the tools themselves declare concurrency-safe run together; an
    // unsafe one runs alone and acts as a barrier, so `Edit` after `Write` on
    // the same file still sees the write. See tool-batching.ts.
    const results: {
      tool_use_id: string;
      content: string;
      is_error?: boolean;
      image?: { base64: string; mediaType: string };
    }[] = [];

    const runOne = async (tc: {
      id: string;
      name: string;
      input: Record<string, unknown>;
    }): Promise<(typeof results)[number]> => {
      onEvent({
        type: "tool_result",
        toolUseID: tc.id,
        toolName: tc.name,
        content: "Running...",
      });
      const result = await executeVendorTool({
        sessionId,
        toolUseID: tc.id,
        name: tc.name,
        input: tc.input,
        model: runModel,
        // Read now, not when the turn started: see the note on the option.
        permissionMode:
          typeof permissionModeOption === "function"
            ? permissionModeOption()
            : permissionModeOption,
        requestPermission,
        askUser,
        askPlanApproval,
        signal,
        space,
        unattended,
        // A goal's grants are added to the run's own. This is the whole
        // connector story for goal mode: the user decides ONCE, when starting
        // the goal, which outward actions it may take on its own. Anything
        // else still reaches them as a question, however autonomous the rest
        // of the run is — a goal that keeps working for twenty turns must not
        // acquire the right to send mail along the way.
        connectorGrants: [
          ...(options.connectorGrants ?? []),
          ...(activeGoal?.status === "active" ? activeGoal.connectorGrants : []),
        ],
        onProgress: (text) => {
          onEvent({
            type: "tool_result",
            toolUseID: tc.id,
            toolName: tc.name,
            content: text,
          });
        },
        onSubAgentEvent: (u) => {
          onEvent({
            type: "subagent",
            toolUseID: tc.id,
            kind: u.kind,
            agentType: u.kind === "start" ? u.agentType : undefined,
            description: u.kind === "start" ? u.description : undefined,
            background: u.kind === "start" ? u.background : undefined,
            text: u.kind === "text" ? u.text : undefined,
            childId:
              u.kind === "tool" || u.kind === "tool_done" ? u.id : undefined,
            name:
              u.kind === "tool" || u.kind === "tool_done" ? u.name : undefined,
            input: u.kind === "tool" ? u.input : undefined,
            output: u.kind === "tool_done" ? u.output : undefined,
            isError: u.kind === "tool_done" ? u.isError : undefined,
          });
        },
      });
      onEvent({
        type: "tool_result",
        toolUseID: tc.id,
        toolName: tc.name,
        content: result.content,
        final: true,
      });
      // Closes the log row. Deliberately here and not on every tool_result
      // event: the placeholder before execution and each onProgress update are
      // the same event type, and closing on one of those would stamp a row
      // "Completed" with the word "Running..." as its output. The `final` flag
      // above says the same thing to anyone downstream — the renderer's task
      // panel was doing exactly that, since it only had the event to go on.
      recordFinish(tc.id, result.content, result.isError === true);
      return {
        tool_use_id: tc.id,
        content: result.content,
        is_error: result.isError || undefined,
        image: result.image,
      };
    };

    const batches = planBatches(toolCalls, toolConcurrencyLookup(space, sessionId));
    const batchRun = await runBatches(batches, runOne, () => signal?.aborted === true);
    results.push(...batchRun.results);
    if (batchRun.aborted) {
      onEvent({ type: "error", error: "Aborted" });
      onEvent({ type: "message_stop", stop_reason: "abort" });
      return;
    }

    // Anything the user typed while these tools ran. It rides along with the
    // results because that user message is the only legal slot for text
    // between an assistant's tool_use blocks and its next step.
    const injected = drainInjections(sessionId);
    for (const note of injected)
      onEvent({ type: "user_message", content: note });

    messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.tool_use_id,
        // A screenshot is attached as an image block so the model can see it.
        content: r.image
          ? [
              { type: "text" as const, text: r.content },
              {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: r.image.mediaType,
                  data: r.image.base64,
                },
              },
            ]
          : r.content,
        is_error: r.is_error,
      })),
    });
    if (injected.length > 0) {
      const last = messages[messages.length - 1]!;
      if (Array.isArray(last.content))
        last.content.push({ type: "text", text: formatInjection(injected) });
    }
    persistTranscript(sessionId);
  }

  // Loop fell through maxTurns without a natural end (no more tool calls) —
  // emit the terminal message_stop anyway so the UI doesn't stay stuck
  // "streaming" forever.
  persistTranscript(sessionId);
  onEvent({ type: "message_stop", stop_reason: "max_turns" });
}
