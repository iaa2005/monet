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
import { isFeatureOn } from "./features.js";
import {
  LOOK_FIRST_NOTE,
  planWasMade,
  RECON_DONE,
  RECON_PROMPT,
  RECON_TIMEUP,
  RECON_TURNS,
  reconTools,
} from "./recon.js";
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
import { buildLessonsPrompt } from "../memory/lessons.js";
import { buildVaultPrompt, seedVaultPrompt } from "../obsidian/prompt.js";
import { getWorkspacePath } from "../ipc/workspace.js";
import { goalHistoryBlock, goalRunNotes } from "./run-notes.js";
import {
  appendUserText,
  isEmptyReply,
  MAX_NUDGES,
  shouldNudge,
} from "./empty-turn.js";
import {
  budgetWarning,
  callSignature,
  dominantRepeat,
  extensionFor,
  extensionNote,
  loopNote,
  MAX_LOOP_STEERS,
  reachableBudget,
  shouldSteerLoop,
  shouldWarnBudget,
  WRAP_UP_PROMPT,
} from "./turn-budget.js";
import { getProfilePrompt } from "../app/profile.js";
import { agentIdentityPrompt } from "./identity.js";
import { tunablePrompt } from "../prompts/index.js";
import {
  isCaveman,
  cavemanDirective,
  CAVEMAN_COMPACT_HINT,
  withCavemanReminder,
} from "./caveman.js";
import { turnRange } from "./turn-context.js";
import { anyWriters, WRITERS } from "./writers.js";
import {
  changedIn,
  foldDelta,
  EMPTY_DELTA,
  type Delta,
} from "./file-ledger.js";
import { clearRevealedTools } from "./revealed-tools.js";
import { deferredLines } from "./deferred-inventory.js";
import { browserDirective } from "./browser-directive.js";
import { getToolSearchConfig } from "./toolsearch-config.js";
import {
  loadTranscriptWithMeta,
  listContextEvents,
  replaceTranscript,
  clearTranscript,
  recordContextEvent,
} from "../session/transcript.js";
import type { AskUserFn } from "../ipc/ask-user.js";
import type { AskPlanApprovalFn } from "../ipc/plan.js";
import { resolveModel } from "../provider/routing.js";
import { recordFinish, recordStart, settleSession } from "../session/task-log.js";

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
  injectionBlocks,
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
    if (prompt.trim().length > 0)
      return withUserMemory(prompt, includeMemory, space, model);
    throw new Error("vendor system prompt came back empty");
  } catch (err) {
    console.warn(
      "[agent] vendor getSystemPrompt failed, using fallback:",
      err instanceof Error ? err.message : err,
    );
    return withUserMemory(
      await getFallbackSystemPrompt(),
      includeMemory,
      space,
      model,
    );
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

/**
 * What "make it nice" has to be replaced with.
 *
 * A weak model told to make a good interface produces a grey wall of
 * unlabelled buttons, because "good" is not an instruction it can check
 * itself against. Every line here is a thing that can be LOOKED FOR in the
 * result — a state that exists or does not, a scale that is one scale or
 * several. Tunable via prompts/design.md.
 */
const DESIGN_DEFAULT = [
  "# Interface standards (when you build or change UI)",
  "- ONE spacing scale (4/8/12/16/24…). Never invent one-off margins.",
  "- ONE accent colour, from the existing theme. Everything else is text,",
  "  surface and border. Do not introduce a second brand hue.",
  "- Every control has four states: rest, hover, active/pressed, disabled —",
  "  and a visible keyboard focus ring. A control with one state looks dead.",
  "- Every button says what it DOES (\"Save changes\", not \"OK\"). Destructive",
  "  actions are visually distinct and confirmed.",
  "- Every list and panel has an EMPTY state, a LOADING state and an ERROR",
  "  state, each with one sentence saying what to do next. Blank is not a state.",
  "- Nothing moves under the pointer: no layout shift when data arrives, no",
  "  content jumping as images load. Reserve the space.",
  "- Text: one family, at most three sizes on a screen, and real contrast —",
  "  body text near-black on light, never mid-grey on grey.",
  "- Anything slower than ~300ms shows progress; anything irreversible asks",
  "  first; anything that failed says why, in words, where it failed.",
  "- Check it at a narrow window too. Horizontal scrollbars on the page are a",
  "  bug, not a layout.",
].join("\n");

export function agentDesignPrompt(): string {
  return tunablePrompt("design", DESIGN_DEFAULT);
}

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
function withUserMemory(
  prompt: string,
  includeMemory = true,
  space?: string,
  model?: string,
): string {
  try {
    const extra = [
      // What it is, before who the user is: with this slot empty a weak model
      // fills it from training and introduces itself by an invented name.
      agentIdentityPrompt(model),
      getProfilePrompt(),
      // The switch a routine flips: everything else here is style and
      // discipline, but THIS is the user's private notebook.
      includeMemory ? buildMemoryPrompt() : "",
      // The vault map + protocol — present only while a vault is enabled.
      buildVaultPrompt(),
      // Project lessons ride only into chats working in THAT workspace —
      // Home has no workspace, and a lesson about this repo's flaky build
      // belongs in no other folder's context. The run pinned its cwd before
      // the prompt was built, so the global path is this run's path.
      includeMemory && space !== "home" && isFeatureOn("lessons")
        ? buildLessonsPrompt(getWorkspacePath())
        : "",
      // Each of these is paid on EVERY turn, which is why each is a switch —
      // see shared/agent-features.ts.
      isFeatureOn("method") ? tunablePrompt("method", METHOD_DEFAULT) : "",
      isFeatureOn("discipline")
        ? tunablePrompt("discipline", DISCIPLINE_DEFAULT)
        : "",
      isFeatureOn("design") ? agentDesignPrompt() : "",
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
    seedVaultPrompt();
    (await import("../memory/store.js")).memoryPreamble();
    getProfilePrompt();
    agentIdentityPrompt();
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
  /**
   * The id of the user bubble this prompt is drawn as.
   *
   * The chat and the model transcript are two tables, and this is the one
   * thread between them. Without it the transcript would mint its own id
   * and the chat could not say "this bubble is that turn" — which is
   * exactly the arithmetic-by-counting the flag replaced.
   */
  userMessageId?: string;
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
  compactionFloor.delete(sessionId);
  clearTranscript(sessionId);
  dropSessionContext(sessionId);
  clearSessionGrants(sessionId);
  clearRevealedTools(sessionId);
}

/**
 * What the running turn has changed on disk so far.
 *
 * Filled a WINDOW at a time — one index of the folder before a batch of
 * tools runs and one after — so a file a Python script wrote is caught
 * along with the ones Edit named, and a file the user edits while the
 * model is thinking is not. See file-ledger.ts for why that distinction
 * is the whole design.
 */
const turnLedgers = new Map<string, Delta>();

/** The folder this run is working in — the same source the end-of-turn
 * snapshot uses, so the window and the commit describe one folder. */
let cwdForRun: (() => string | undefined) | null = null;
function getCwdForRun(): string | undefined {
  return cwdForRun?.();
}

/**
 * The folder a turn changes, whichever space it is in.
 *
 * Code works in the run's cwd. Home works in the chat's SANDBOX, which is
 * a folder on disk like any other — and was the one place with no
 * versioning at all, so edit-and-retry there had nothing to restore.
 */
async function turnFolder(
  space: string | undefined,
  sessionId: string,
): Promise<string | undefined> {
  if (space === "home") {
    try {
      const { sandboxWorkDir } = await import("../sandbox/podman-engine.js");
      return sandboxWorkDir(sessionId);
    } catch {
      return undefined;
    }
  }
  return getCwdForRun();
}

/** Transcript user-turn messages with NO display bubble — background-delivery
 * turns (deliverBackgroundResults sends an empty message that only carries a
 * finished sub-agent's report). Tracked by object identity so compaction and
 * truncation "forget" them for free; persisted via the transcript `hidden`
 * column so the tagging survives a reopen. Excluding them keeps the rewind
 * user-turn count aligned with the visible user bubbles. */
const hiddenTurns = new WeakSet<LLMMessage>();

/**
 * A model message's identity and whether the model may still read it.
 *
 * By object identity, like `hiddenTurns` — the in-memory array is the live
 * thing and these ride along with it, so a message keeps its id and its
 * context flag through compaction, rewinds and reordering without anyone
 * having to thread them through every call.
 */
const messageIds = new WeakMap<LLMMessage, string>();
const outOfContext = new WeakSet<LLMMessage>();

let idCounter = 0;
function newMessageId(): string {
  idCounter += 1;
  return `t${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** Its id, minting one the first time anybody asks. */
export function transcriptId(m: LLMMessage): string {
  let id = messageIds.get(m);
  if (!id) {
    id = newMessageId();
    messageIds.set(m, id);
  }
  return id;
}

/** Can the model still read this message? */
export function isInContext(m: LLMMessage): boolean {
  return !outOfContext.has(m);
}

/** Take a message out of the model's view, or put it back. The message
 * itself is never removed — that is the whole point of the flag. */
export function setInContext(m: LLMMessage, inContext: boolean): void {
  if (inContext) outOfContext.delete(m);
  else outOfContext.add(m);
}

/**
 * Move everything that makes a message THAT message onto a rewritten copy of
 * it — its id, its context flag, whether it is a hidden background turn.
 *
 * Compaction's lossless pass rewrites a message to blank an old tool result.
 * The rewrite is a new object, and all three of those live on object
 * identity, so without this the message silently becomes a different one: a
 * new id (the chat can no longer point at its turn) and back in context (a
 * prompt the user removed starts being sent again).
 */
export function carryIdentity(from: LLMMessage, to: LLMMessage): void {
  const id = messageIds.get(from);
  if (id) messageIds.set(to, id);
  if (outOfContext.has(from)) outOfContext.add(to);
  if (hiddenTurns.has(from)) hiddenTurns.add(to);
}

/** Write the session's live model history through to the durable transcript. */
function persistTranscript(sessionId: string): void {
  const msgs = conversations.get(sessionId);
  if (msgs)
    replaceTranscript(
      sessionId,
      msgs,
      msgs.map((m) => hiddenTurns.has(m)),
      {
        ids: msgs.map((m) => transcriptId(m)),
        inContext: msgs.map((m) => isInContext(m)),
      },
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
  const { messages, hidden, ids, inContext } = loadTranscriptWithMeta(sessionId);
  if (messages.length > 0) {
    conversations.set(sessionId, messages);
    let missingIds = false;
    messages.forEach((m, i) => {
      if (hidden[i]) hiddenTurns.add(m);
      const id = ids[i];
      if (id) messageIds.set(m, id);
      else missingIds = true;
      if (inContext[i] === false) outOfContext.add(m);
    });
    // A chat written before messages had ids gets them now, once, and is
    // then on the same footing as every other chat. No second code path
    // for "old transcripts" — there is only one kind.
    if (missingIds) persistTranscript(sessionId);
  }
}

/** Text-only rebuild from the persisted display messages — for /compact on a
 * reopened chat that has neither in-process history nor a durable transcript
 * (old, un-migrated). Not used on the send path (which has the seed). */
async function seedFromDisplayMessages(sessionId: string): Promise<void> {
  if (conversations.has(sessionId)) return;
  try {
    const { getSessionStore } = await import("../session/store.js");
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
 * The size at which summarising this chat turned out not to help.
 *
 * Compaction is not guaranteed to shrink anything: the summary has a floor of
 * a few hundred tokens whatever it is given, so a small history compacts to
 * something larger than itself. Without this the chat would then be over the
 * threshold on the next turn too, and spend a model call finding that out
 * again, every turn, forever. Cleared by growth — a bigger conversation is a
 * new question.
 */
const compactionFloor = new Map<string, number>();

/**
 * The ids and context flags of a message list, as plain arrays.
 *
 * A compaction event stores the pre-compaction history so it can be undone,
 * and it stores it as DATA — copies, with none of the identity the live
 * messages carry in WeakMaps. Undoing without these gives every message a
 * fresh id and puts the whole lot back in context, including prompts the
 * user had taken out before compacting.
 */
function snapshotIdentity(msgs: LLMMessage[]): {
  beforeIds: string[];
  beforeInContext: boolean[];
} {
  return {
    beforeIds: msgs.map((m) => transcriptId(m)),
    beforeInContext: msgs.map((m) => isInContext(m)),
  };
}

function worthCompacting(sessionId: string, live: LLMMessage[]): boolean {
  const floor = compactionFloor.get(sessionId);
  return floor === undefined || estimateTokens(live) > floor;
}

function noteCompactionFloor(sessionId: string, tokens: number): void {
  compactionFloor.set(sessionId, tokens);
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
  // The live objects, for their ids and flags; the copies, for the content.
  const beforeLive = [...messages];
  const beforeSnapshot = messages.map((m) => ({ ...m }));
  const before = estimateTokens(messages.filter(isInContext));
  const compacted = await compactMessages({
    messages,
    adapter,
    model: provider.model,
    maxTokens: provider.maxTokens || 16000,
    // Asked for by hand, but the rules are the same: a prompt the user took
    // out of context is not summarised back in, and a "compaction" that made
    // the context bigger is not applied.
    //
    // The threshold is passed so pass 1 can stop early: clearing old tool output
    // is lossless and free, and if that alone gets under the line there is no
    // reason to pay for a summary. Without it the manual path always summarised.
    // A smaller buffer than the automatic one — this was asked for, so the point
    // is to reclaim room now rather than to leave headroom for a turn that may
    // never come.
    threshold: compactionThreshold(
      {
        inputLimit: provider.inputLimit,
        contextLimit: provider.contextLimit,
        outputReserve: provider.maxTokens || 16000,
      },
      "manual",
    ),
    inContext: isInContext,
    carry: carryIdentity,
  });
  if (compacted !== messages) {
    messages.length = 0;
    messages.push(...compacted);
  }
  const after = estimateTokens(messages.filter(isInContext));
  // Record the compaction so it can be undone ("rewind through compact"):
  // the BEFORE snapshot restores the pre-compaction context.
  if (after < before)
    recordContextEvent(sessionId, "compact", {
      manual: true,
      beforeTokens: before,
      afterTokens: after,
      // Where the context now starts, in turns — see contextHeadOffset.
      userTurnsBefore: countUserTurns(beforeSnapshot),
      userTurnsAfter: countUserTurns(messages),
      headOffset: contextHeadOffset(sessionId),
      before: beforeSnapshot,
      ...snapshotIdentity(beforeLive),
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

/**
 * Take one prompt out of the model's context, or put it back — WITH the
 * turn it started.
 *
 * The unit is the whole turn, and that is not tidiness: an assistant
 * message carrying `tool_use` whose `tool_result` is missing (or the
 * reverse) is a request the API rejects outright. So marking a user
 * message marks everything up to the next visible user turn — its reply,
 * its tool calls and their results.
 *
 * Nothing is deleted. That is what makes this reversible, and what lets
 * the chat go on showing a prompt it has stopped sending.
 */
export function setTurnContext(
  sessionId: string,
  messageId: string,
  inContext: boolean,
): { ok: boolean; changed: number } {
  const msgs = conversations.get(sessionId);
  if (!msgs) return { ok: false, changed: 0 };
  const start = msgs.findIndex((m) => transcriptId(m) === messageId);
  const range = turnRange(msgs, start, isUserTurnBoundary);
  if (!range) return { ok: false, changed: 0 };

  let changed = 0;
  for (let i = range.start; i < range.end; i++) {
    if (isInContext(msgs[i]) !== inContext) changed++;
    setInContext(msgs[i], inContext);
  }
  if (changed > 0) persistTranscript(sessionId);
  return { ok: true, changed };
}

/** What would actually be sent right now — the transcript minus everything
 * taken out of context. The request path and the token estimate both go
 * through this, so "what the model sees" has one definition. */
export function messagesInContext(sessionId: string): LLMMessage[] {
  return (conversations.get(sessionId) ?? []).filter(isInContext);
}

/** The visible user turns, oldest first, with whether each is still being
 * sent — everything the chat and the meter need to draw the truth. */
export function turnContextState(
  sessionId: string,
): { id: string; inContext: boolean }[] {
  const msgs = conversations.get(sessionId) ?? [];
  return msgs
    .filter(isUserTurnBoundary)
    .map((m) => ({ id: transcriptId(m), inContext: isInContext(m) }));
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
    recordContextEvent(sessionId, "rewind", {
      keepUserTurns,
      removed,
      // The TRANSCRIPT's own count, not the display's: the map is drawn in
      // context turns and translated by headOffset.
      userTurnsBefore: boundaries,
      userTurnsAfter: keepUserTurns,
      headOffset: contextHeadOffset(sessionId),
    });
  // Discarded turns leave stale derived state.
  lastUsageBySession.delete(sessionId);
  dropSessionContext(sessionId);
  clearRevealedTools(sessionId);
  return { fidelity: "full", removed };
}

/**
 * How many prompts can still be taken back.
 *
 * The ones still being SENT: a prompt already out of context cannot be
 * removed a second time, and counting it made the meter offer to undo
 * something that was already undone. Loads the transcript first so a chat
 * reopened this process answers from its own history rather than from
 * nothing.
 */
export async function undoableTurnCount(sessionId: string): Promise<number> {
  await ensureTranscriptLoaded(sessionId);
  return turnContextState(sessionId).filter((t) => t.inContext).length;
}

/** User turns in a message list — the unit the context map is drawn in. */
function countUserTurns(msgs: LLMMessage[]): number {
  return msgs.filter(isUserTurnBoundary).length;
}

/**
 * How many user turns this chat has already lost off the FRONT of its
 * context, summed over every compaction so far.
 *
 * The transcript renumbers itself after a compaction — turn 1 of the context
 * is no longer turn 1 of the conversation — while the chat on screen keeps
 * every message it ever showed. This offset is what translates between them,
 * and it is why each event records the count it saw: with it, the renderer
 * can say exactly which messages the model can no longer read.
 */
function contextHeadOffset(sessionId: string): number {
  try {
    return listContextEvents(sessionId)
      .filter((e) => e.type === "compact")
      .reduce((n, e) => {
        const before = Number(e.payload.userTurnsBefore ?? 0);
        const after = Number(e.payload.userTurnsAfter ?? 0);
        return n + Math.max(0, before - after);
      }, 0);
  } catch {
    return 0;
  }
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
  await ensureTranscriptLoaded(sessionId);
  // The turns still being sent — an already-removed prompt is not a
  // candidate for removal a second time.
  const live = turnContextState(sessionId).filter((t) => t.inContext);
  const removed = Math.max(0, Math.min(count, live.length));
  if (removed === 0)
    return { removed: 0, turnsLeft: live.length, messagesDropped: 0 };

  const before = conversations.get(sessionId)?.length ?? 0;
  // Marked, not truncated. The messages stay in the transcript and on
  // screen; they simply stop being sent, which is reversible and is the
  // same operation "remove this one prompt" performs on a turn further up.
  let messagesDropped = 0;
  for (const turn of live.slice(-removed))
    messagesDropped += setTurnContext(sessionId, turn.id, false).changed;
  const result = { fidelity: "full" as const, removed: messagesDropped };
  const available = live.length;
  const after = before;

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

  // Still recorded, because the context timeline is worth having — but it
  // is now a LOG, not the source of truth. What is out of context is a
  // flag on the messages themselves; nobody reconstructs it by replaying
  // these events any more.
  recordContextEvent(sessionId, "rewind", {
    undo: true,
    removedTurns: removed,
    fidelity: result.fidelity,
  });

  return {
    removed,
    turnsLeft: available - removed,
    messagesDropped,
  };
}

export async function undoCompaction(
  sessionId: string,
  eventId: string,
): Promise<{ restored: number } | null> {
  const { getContextEvent, dropContextEventsFrom } = await import(
    "../session/transcript.js"
  );
  const ev = getContextEvent(sessionId, eventId);
  if (!ev || ev.type !== "compact") return null;
  const before = ev.payload.before as LLMMessage[] | undefined;
  if (!Array.isArray(before) || before.length === 0) return null;
  // The snapshot is plain data — copies, with none of the WeakMap/WeakSet
  // identity the live messages carry. Restored bare, every message would
  // come back with a fresh id (the chat could no longer point at its turn)
  // and IN context, which would put back prompts the user had removed
  // before the compaction. The event carries both alongside.
  const ids = ev.payload.beforeIds as (string | null)[] | undefined;
  const flags = ev.payload.beforeInContext as boolean[] | undefined;
  const restored = before.map((m, i) => {
    const copy = { ...m };
    const id = ids?.[i];
    if (id) messageIds.set(copy, id);
    if (flags && flags[i] === false) outOfContext.add(copy);
    return copy;
  });
  conversations.set(sessionId, restored);
  persistTranscript(sessionId);
  dropContextEventsFrom(sessionId, ev.seq);
  return { restored: estimateTokens(before) };
}

/** Rough input-token estimate of what a session would SEND — everything the
 * user took out of context costs nothing, and the two callers (the meter and
 * "will this fit the model you are switching to?") both mean that. */
export function estimateSessionTokens(sessionId: string): number {
  const messages = conversations.get(sessionId);
  return messages ? estimateTokens(messages.filter(isInContext)) : 0;
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
 * Files the session's last runAgent call actually changed — what gates the
 * verification loop. Only the dedicated edit tools count: a Bash `git status`
 * changing nothing must not trigger a typecheck, and the model does its edits
 * through these tools. Reset at the start of every run, so a fix attempt is
 * judged by what IT edited, not by what the original turn did.
 */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const editedFilesBySession = new Map<string, Set<string>>();

export function lastRunEditedFiles(sessionId: string): string[] {
  return [...(editedFilesBySession.get(sessionId) ?? [])];
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
): Promise<ContextBreakdown> {
  const provider = getProviderManager().getActive();
  const budget = provider?.inputLimit ?? provider?.contextLimit ?? 200_000;
  // The renderer's estimate is a FALLBACK, not a preference — and getting that
  // backwards is why "/compact does nothing" was reported on a chat the meter
  // said held 300k tokens.
  //
  // The renderer counts the VISIBLE messages, tool output included. Compaction
  // truncates the model-facing transcript and never touches the display rows, so
  // the override could not move: a manual compaction that really did run (3405
  // tokens down to 2764, recorded in context_events) left the meter reading the
  // same 300k, because that 300k was the display table and had not been sent to
  // a model in the first place.
  //
  // So: when this process actually holds the conversation, measure THAT, and
  // only what is still in context — a prompt taken out stops costing tokens and
  // the meter has to say so. The override answers for the one case it was added
  // for: an old chat this process has never run.
  // ONE source: the transcript, which is what the model is actually sent. The
  // live map when a turn has run, the durable rows otherwise (it stays empty
  // until then — measured: live 0 messages, stored 9).
  //
  // There used to be a third source, and it was the bug: the renderer passed an
  // estimate of the VISIBLE messages, tool output included, and it always won.
  // So a chat whose model context was 2,764 tokens reported 537,000, and a
  // manual compaction that really ran — 3,405 down to 2,764, in context_events —
  // moved the number not at all, because that number was the display table.
  // A meter that measures something compaction cannot touch is not a meter.
  const live = conversations.get(sessionId);
  const counted =
    live && live.length > 0
      ? live.filter(isInContext)
      : (() => {
          const stored = loadTranscriptWithMeta(sessionId);
          return stored.messages.filter((_, i) => stored.inContext[i] !== false);
        })();
  const messageTokens = estimateTokens(counted);

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
      const { loadClaudeMd } = await import("../workspace/claude-md.js");
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

  // Fresh slate for the verification gate: this run's edits, not history's.
  editedFilesBySession.set(sessionId, new Set());

  // Only a running session can take a mid-turn injection, and anything still
  // undelivered when this returns is dropped rather than carried into the
  // next turn — see injection.ts.
  markRunning(sessionId);
  try {
    // Scope the run to its session so deep tool code (browser tabs) can tell
    // whose desk it is working for. See agent/run-session.ts.
    const { runSession } = await import("./run-session.js");
    return await runSession.run(sessionId, () =>
      runWithCwdOverride(runCwd, () =>
        runAgentScoped(sessionId, userContent, onEvent, options),
      ),
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

  // Where this run works, for the file windows below — the same source
  // the end-of-turn snapshot uses, so a window and its commit can never
  // describe two different folders.
  {
    const { getCwd } = await import("@vendor/utils/cwd.js");
    cwdForRun = () => getCwd();
  }

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
    // What earlier goals in this workspace did — continuity, not ceremony.
    // Home has no workspace to remember.
    let history: string | undefined;
    if (
      activeGoal.status === "active" &&
      space !== "home" &&
      isFeatureOn("runNotes")
    ) {
      try {
        history =
          goalHistoryBlock(goalRunNotes(getWorkspacePath())) ?? undefined;
      } catch {
        /* the reminder stands on its own */
      }
    }
    const note =
      activeGoal.status === "active"
        ? activeGoalReminder(activeGoal, history)
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
  // The bubble's id, so the chat can point at this turn later. Without it
  // the two sides could only be matched by counting, which is the thing
  // the flag exists to stop.
  if (options.userMessageId) messageIds.set(userMsg, options.userMessageId);
  if (hiddenTurn) hiddenTurns.add(userMsg);
  persistTranscript(sessionId);

  // A model that answers with nothing gets nudged rather than believed —
  // see empty-turn.ts. Per RUN, so a nudge spent here does not follow the
  // chat into the next message.
  let nudgesUsed = 0;
  let nudgedLastTurn = false;

  // The step budget MOVES: a run that keeps producing new work earns more
  // turns, a run repeating itself does not. `maxTurns` is where it starts,
  // not where it must end — see turn-budget.ts.
  let budget = maxTurns;
  let extensionsUsed = 0;
  const callSignatures: string[] = [];
  // Which budget the heads-up was already spent on. Latched per budget rather
  // than per run: an extension gives the run a new true end, and it deserves
  // one warning before that one too.
  let warnedForBudget: number | null = null;

  // Loop steering: the same repetition evidence the budget consults, but
  // spoken while there is still time to act on it. See turn-budget.ts.
  let loopSteersUsed = 0;
  let lastSteerAt = 0;

  // Reconnaissance: the first turns run with the writing tools taken away,
  // so the model cannot start coding before it has looked. Ends when it
  // stops calling tools — which is the plan — or when the looking budget
  // runs out. See recon.ts; the prompt rides in with the user's own.
  // Not predicted from the prompt any anymore: the phase opens when a write is
  // attempted with nothing read, which is the condition it was always about and
  // is the same condition in every language. See recon.ts.
  let reconLeft = 0;
  // How much looking the recon phase actually did. Zero means the model
  // answered outright, which is not a plan — see planWasMade.
  let reconToolCalls = 0;
  /** Reads this run has done, and whether the one-shot guard is spent. */
  let readsThisRun = 0;
  let lookFirstSpent = false;
  /** Set by the guard, acted on after the batch — a harness line between a
   * tool_use and its tool_result is a 400 from every provider. */
  let openReconAfterBatch = false;
  if (reconLeft > 0) {
    appendUserText(messages, RECON_PROMPT);
    onEvent({
      type: "harness",
      text: "Reconnaissance — reading before writing",
    });
  }

  for (let turn = 0; turn < budget; turn++) {
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
    const aim = cave ? Math.floor(threshold * 0.6) : threshold;
    // Measured on what is actually SENT. Counting prompts the user removed
    // would compact a chat that is already small enough — and then summarise
    // those very prompts back into it.
    const live = messages.filter(isInContext);
    if (shouldCompact(live, aim) && worthCompacting(sessionId, live)) {
      const beforeLive = [...messages];
      const beforeSnapshot = messages.map((m) => ({ ...m }));
      const beforeTokens = estimateTokens(live);
      const compacted = await compactMessages({
        messages,
        adapter,
        model: runModel,
        maxTokens: provider.maxTokens || 16000,
        signal,
        terseHint: cave ? CAVEMAN_COMPACT_HINT : undefined,
        // Lets compaction stop after the lossless pass when that already fits.
        threshold: aim,
        inContext: isInContext,
        carry: carryIdentity,
      });
      if (compacted === messages) {
        // It had nothing to give at this size. Don't ask again until the
        // conversation has actually grown past the point where it failed —
        // otherwise every turn from here spends a summarisation call.
        noteCompactionFloor(sessionId, beforeTokens);
      } else {
        messages.length = 0;
        messages.push(...compacted);
        // Log the auto-compaction with a BEFORE snapshot so it can be undone
        // (rewind through compact → restore the pre-compaction context).
        recordContextEvent(sessionId, "compact", {
          manual: false,
          beforeTokens,
          // Both numbers describe the same thing — what the model is sent —
          // so "did it shrink?" is a question the event can be asked.
          afterTokens: estimateTokens(messages.filter(isInContext)),
          // Where the context now starts, in turns — see contextHeadOffset.
          userTurnsBefore: countUserTurns(beforeSnapshot),
          userTurnsAfter: countUserTurns(messages),
          headOffset: contextHeadOffset(sessionId),
          before: beforeSnapshot,
          ...snapshotIdentity(beforeLive),
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
    // What the model actually gets: everything still in context. A message
    // taken out — an undone prompt, one removed by hand, the front of a
    // compacted chat — stays in the array and stays on screen; it just is
    // not sent. Whole turns only (see setTurnContext), because an
    // assistant `tool_use` without its `tool_result` is a request the API
    // refuses outright.
    const turnMessages = withCavemanReminder(messages.filter(isInContext), cave);
    // While reconnaissance lasts, the model is handed a toolset in which
    // starting to code is not an available action.
    const turnTools = reconLeft > 0 ? reconTools(tools) : tools;

    try {
      await adapter.stream(
        {
          model: runModel,
          system: systemPrompt,
          messages: turnMessages,
          tools: turnTools,
          max_tokens: provider.maxTokens || 16000,
          temperature: provider.temperature,
          effort: provider.supportsEffort ? effort : undefined,
          routing: provider.routing,
        },
        (event) => {
          if (event.type === "text_delta") assistantText += event.text;
          if (event.type === "tool_use") {
            toolCalls.push({
              id: event.id,
              name: event.name,
              input: event.input,
            });
            // What the budget's extension decision is made of: repetition is
            // the difference between a long job and a stuck one.
            callSignatures.push(callSignature(event.name, event.input ?? {}));
            if (reconLeft > 0) reconToolCalls++;
          }
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

    if (toolCalls.length === 0 && reconLeft > 0 && assistantText.trim()) {
      // In a normal turn "no tool calls" means finished. In reconnaissance
      // it means the looking is over and THIS is the plan — so the phase
      // ends, the full toolset comes back, and the run carries on rather
      // than stopping with a plan and no work.
      //
      // Unless nothing was looked at. Then the two readings come apart and this
      // one is wrong: a request that needed no files answered in one turn, and
      // being told to "do the work, following the plan you just wrote" made it
      // invent work. Asked to translate a commit message, it went looking for
      // the repository on GitHub for ten turns. Counting the recon phase's own
      // tool calls tells the cases apart — see planWasMade.
      reconLeft = 0;
      if (!planWasMade(reconToolCalls)) {
        onEvent({
          type: "harness",
          text: "Answered without needing to look — nothing to carry out",
        });
        // Falls through to the ordinary end-of-turn path below.
      } else {
        appendUserText(messages, RECON_DONE);
        onEvent({ type: "harness", text: "Plan in hand — starting the work" });
        persistTranscript(sessionId);
        continue;
      }
    }

    if (toolCalls.length === 0) {
      // The model is done — unless the user said something while it worked.
      // Deliver that as a new user message and keep going, rather than ending
      // the turn and making them press send on a correction they already
      // typed. This is the ONLY natural end of a run, so it is also the last
      // chance to deliver.
      const lateNotes = drainInjections(sessionId);
      if (lateNotes.length > 0) {
        const text = formatInjection(lateNotes);
        const media = injectionBlocks(lateNotes);
        messages.push({
          role: "user",
          content: media.length ? [{ type: "text", text }, ...media] : text,
        });
        for (const note of lateNotes)
          onEvent({ type: "user_message", content: note.text });
        persistTranscript(sessionId);
        continue;
      }

      // Nothing at all came back — no text, no tool calls. That is not an
      // answer, and taking it as one ends the run mid-task in silence (there
      // is no content to write, so even the transcript keeps no trace). Send
      // what a person would send by hand: a bare "." — see empty-turn.ts for
      // why it joins the last user message instead of becoming a new one, and
      // why it is bounded.
      const empty = isEmptyReply(assistantText, toolCalls.length);
      if (
        isFeatureOn("nudge") &&
        shouldNudge({ emptyReply: empty, nudgesUsed, nudgedLastTurn })
      ) {
        nudgesUsed++;
        nudgedLastTurn = true;
        console.warn(
          `[agent] empty reply (stop_reason=${lastStopReason ?? "n/a"}) — nudging (${nudgesUsed}/${MAX_NUDGES})`,
        );
        onEvent({
          type: "harness",
          text: `The model answered with nothing — nudged it to continue (${nudgesUsed}/${MAX_NUDGES})`,
        });
        appendUserText(messages);
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
        // A run that ends with nothing said: the one distinction a
        // post-mortem needs, and the only trace such a turn leaves.
        empty,
      });
      // Code Rewind: snapshot the folder AFTER the reply is done (never
      // blocks it) so this turn can be restored later.
      //
      // Home DOES have a folder — the chat's sandbox — and it was the one
      // place with no versioning at all, which is why editing and
      // retrying a prompt there restored nothing. It is a folder like any
      // other; the only difference is where it lives.
      {
        try {
          const { snapshotWorkspace, saveLedger } = await import(
            "./checkpoints.js"
          );
          const sha = await snapshotWorkspace(sessionId, await turnFolder(space, sessionId));
          if (sha) {
            // What this turn changed, stored against the commit that
            // holds the content — so a rewind can put back exactly those
            // files and leave the rest of the folder alone.
            //
            // ALWAYS stored, even when the answer was pure conversation and
            // the map is empty. A missing ledger means "this turn is from
            // before ledgers existed", and a rewind across one falls back to
            // a git diff — which cannot tell the turn's changes from the
            // user's, and deletes files they made between turns. Six turns
            // of prose in the middle of a session were enough to lose one.
            saveLedger(sessionId, sha, turnLedgers.get(sessionId) ?? EMPTY_DELTA);
            turnLedgers.delete(sessionId);
            onEvent({ type: "checkpoint", sha });
          }
        } catch {
          /* best-effort */
        }
      }
      return;
    }

    // The model is working again, so a nudge spent earlier no longer counts
    // as "the last thing that happened".
    nudgedLastTurn = false;

    // A looking turn just spent one of its own. The NOTE about running out
    // cannot be written here, though — the assistant message carrying this
    // turn's tool_use blocks is the last one in the array, and a harness
    // line lands as a user message BETWEEN a tool_use and its tool_result.
    // Every provider rejects that outright ("tool_use ids were found without
    // tool_result blocks immediately after"), which is a 400 on the next
    // request and a run that dies for a reason nothing on screen explains.
    // It rides with the tool results instead — see the end of the loop.
    const reconEnded = reconLeft > 0 && --reconLeft === 0;

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
      // LOOK BEFORE YOU WRITE, decided on the action instead of on the words.
      //
      // This used to be predicted from the prompt by `worthRecon`: English
      // action verbs, some Russian stems, a length test. Measured live against
      // DeepSeek with one brief written five ways, it produced three levels of
      // service — English got the phase, Russian got it for a stem typed in an
      // hour earlier, Turkish, German and Chinese got nothing and finished the
      // same work in a third of the time. A trigger that fires by vocabulary is
      // not deciding whether a task needs looking at.
      //
      // The condition the phase actually cares about needs no language at all:
      // a write is about to happen and nothing has been read. That is visible
      // here, exactly once per run, and in every live run so far it would not
      // have fired — a read preceded every write.
      if (
        isFeatureOn("recon") &&
        !lookFirstSpent &&
        readsThisRun === 0 &&
        WRITERS.has(tc.name)
      ) {
        lookFirstSpent = true;
        openReconAfterBatch = true;
        onEvent({
          type: "harness",
          text: `Asked it to read before writing (${tc.name} with nothing read yet)`,
        });
        return {
          tool_use_id: tc.id,
          content: LOOK_FIRST_NOTE,
          is_error: true,
        };
      }
      if (!WRITERS.has(tc.name)) readsThisRun++;
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
      // A successful edit marks the run as having changed the workspace — the
      // signal the verification loop gates on.
      if (!result.isError && EDIT_TOOLS.has(tc.name)) {
        const p = tc.input.file_path ?? tc.input.notebook_path;
        if (typeof p === "string" && p)
          editedFilesBySession.get(sessionId)?.add(p);
      }
      return {
        tool_use_id: tc.id,
        content: result.content,
        is_error: result.isError || undefined,
        image: result.image,
      };
    };

    const batches = planBatches(toolCalls, toolConcurrencyLookup(space, sessionId));

    // The window. Everything that changes on disk between here and the
    // line after the batch belongs to this turn — a file a tool named, a
    // file a script wrote, a file a build produced. What changes OUTSIDE
    // it, while the model is thinking or writing, is the user's and is
    // never touched by a rewind.
    const watching = anyWriters(toolCalls);
    const beforeBatch = watching
      ? await (
          await import("./checkpoints.js")
        ).indexWorkspace(sessionId, await turnFolder(space, sessionId))
      : null;

    const batchRun = await runBatches(batches, runOne, () => signal?.aborted === true);

    if (beforeBatch) {
      try {
        const { indexWorkspace } = await import("./checkpoints.js");
        const afterBatch = await indexWorkspace(
          sessionId,
          await turnFolder(space, sessionId),
        );
        if (afterBatch)
          turnLedgers.set(
            sessionId,
            foldDelta(
              turnLedgers.get(sessionId) ?? EMPTY_DELTA,
              changedIn(beforeBatch, afterBatch),
            ),
          );
      } catch {
        /* a missed window costs precision, not correctness: the rewind
           falls back to saying it cannot restore that turn */
      }
    }
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
      onEvent({ type: "user_message", content: note.text });

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
        last.content.push(
          { type: "text", text: formatInjection(injected) },
          // A file pasted mid-run travels beside its note — images are legal
          // in any user message, tool results or not.
          ...injectionBlocks(injected),
        );
    }

    // A run that keeps re-issuing one identical call is stuck, and from
    // inside, every identical result looks like one more datum rather than a
    // mirror. Say so ONCE, while there are still steps to act on it — capped
    // and spaced so the correction cannot become its own loop.
    if (
      shouldSteerLoop({
        signatures: callSignatures,
        steersUsed: loopSteersUsed,
        sinceLastSteer: callSignatures.length - lastSteerAt,
      })
    ) {
      const rep = dominantRepeat(callSignatures);
      if (rep) {
        loopSteersUsed++;
        lastSteerAt = callSignatures.length;
        console.warn(
          `[agent] loop detected — steering (${loopSteersUsed}/${MAX_LOOP_STEERS}): ${rep.toolName} ×${rep.count}`,
        );
        appendUserText(messages, loopNote(rep.toolName, rep.count));
        onEvent({
          type: "harness",
          text: `Going in circles — ${rep.toolName} ran ${rep.count}× with identical input; asked the model to change approach`,
        });
      }
    }

    // At the wall, but still doing new things? Then the wall was in the wrong
    // place. Bounded and evidence-based: repetition is what refuses it.
    const extra = extensionFor({
      turnsDone: turn + 1,
      budget,
      extensionsUsed,
      signatures: callSignatures,
    });
    if (extra > 0) {
      budget += extra;
      extensionsUsed++;
      console.log(
        `[agent] step budget extended by ${extra} to ${budget} (still producing new work)`,
      );
      onEvent({
        type: "harness",
        text: `Step budget extended by ${extra} (to ${budget}) — the run is still producing new work`,
      });
      appendUserText(messages, extensionNote(extra, budget));
    }

    // A write was refused for want of a read. The phase opens now, with the
    // results in place — the same reason RECON_TIMEUP waits until here.
    if (openReconAfterBatch) {
      openReconAfterBatch = false;
      reconLeft = RECON_TURNS;
      appendUserText(messages, RECON_PROMPT);
      onEvent({ type: "harness", text: "Reconnaissance — reading before writing" });
    }

    // Out of looking turns. Said HERE, where the last message is the tool
    // results this line can join, rather than beside the tool_use blocks it
    // would have separated from them.
    if (reconEnded) {
      appendUserText(messages, RECON_TIMEUP);
      onEvent({ type: "harness", text: "Done looking — starting the work" });
    }

    // The step budget exists whether or not the model knows about it, and
    // until now it did not: it spent forty turns as if they were free and
    // got cut off mid-thought. One line, once per stretch, riding back with
    // the tool results it is about to read — and measured against the budget
    // the run can still REACH, not the one it happens to hold. Told at turn 30
    // of 40 that it had ten steps, a productive run was being lied to by fifty
    // and warned off new work while two thirds of its run remained.
    const warnState = {
      turnIndex: turn,
      budget,
      initialBudget: maxTurns,
      extensionsUsed,
      signatures: callSignatures,
      warnedFor: warnedForBudget,
    };
    if (isFeatureOn("budget") && shouldWarnBudget(warnState)) {
      const left = Math.max(0, reachableBudget(warnState) - (turn + 1));
      warnedForBudget = budget;
      onEvent({
        type: "harness",
        text: `${left} steps left — asked the model to start converging`,
      });
      appendUserText(messages, budgetWarning(left));
    }

    persistTranscript(sessionId);
  }

  // The step budget ran out with work still in flight. Ending here is what
  // the loop used to do, and it threw the whole run away: forty turns of
  // findings and not one word on screen about them. So the run gets ONE more
  // turn with the tools taken away — it cannot act any more, but it can hand
  // the work over. See turn-budget.ts.
  let wrapUpText = "";
  if (!signal?.aborted && isFeatureOn("budget")) {
    onEvent({
      type: "harness",
      text: "Out of steps — asked the model for a handoff summary",
    });
    appendUserText(messages, WRAP_UP_PROMPT);
    try {
      await adapter.stream(
        {
          model: runModel,
          system: systemPrompt,
          messages,
          // No tools: a model that still believes it can act will spend this
          // turn on a call nobody will answer, and end in the same silence.
          tools: [],
          max_tokens: provider.maxTokens || 16000,
          temperature: provider.temperature,
          effort: provider.supportsEffort ? effort : undefined,
          routing: provider.routing,
        },
        (event) => {
          if (event.type === "text_delta") wrapUpText += event.text;
          // Ours is the authoritative one, below.
          if (event.type === "message_stop") return;
          onEvent(event);
        },
        signal,
      );
    } catch (err) {
      // A failed handoff is not worth failing the run over — the turn budget
      // is the thing that ended it either way.
      console.warn(
        `[agent] wrap-up turn failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (wrapUpText) messages.push({ role: "assistant", content: wrapUpText });
  }

  persistTranscript(sessionId);
  onEvent({
    type: "message_stop",
    stop_reason: "max_turns",
    // Nothing said even after being asked to say something.
    empty: !wrapUpText.trim(),
  });
}
