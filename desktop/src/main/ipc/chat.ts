/**
 * Chat IPC handler — streaming chat:send + chat:abort + chat:reset.
 *
 * Uses the agent wrapper, which keeps per-session conversation history so the
 * chat is multi-turn.
 */

import { ipcMain, BrowserWindow } from "electron";
import {
  runAgent,
  resetConversation,
  seedConversation,
  ensureTranscriptLoaded,
  compactSessionNow,
  undoCompaction,
  forkTranscriptToSession,
  rewindTranscriptToUserTurn,
  estimateSessionTokens,
  computeContextBreakdown,
  undoPrompts,
  undoableTurnCount,
  lastTurnTokens,
  lastRunEditedFiles,
} from "../agent/index.js";
import type { UiPermissionMode } from "../agent/permission-types.js";
import { injectMessage } from "../agent/injection.js";
import { expandSlashCommand } from "../agent/skill-tool.js";
import { abortAllBgAgents, abortBgAgents } from "../agent/bg-agents.js";
import { getSessionStore } from "../session-store.js";
import { createAdapter } from "../llm/adapter.js";
import { getProviderManager } from "../provider/manager.js";
import { inferModalities } from "../provider/types.js";
import type { EffortLevel } from "../provider/types.js";
import { requestPermissionFromRenderer } from "./permissions.js";
import { askUserFromRenderer } from "./ask-user.js";
import { askPlanApprovalFromRenderer } from "./plan.js";
import { clearSessionMode } from "../agent/session-mode.js";
import { tunablePrompt } from "../prompts/index.js";
import { getWorkspacePath } from "./workspace.js";
import type { LLMContentBlock } from "../llm/adapter.js";

interface ChatAttachment {
  name: string;
  mediaType: string;
  kind: "text" | "image" | "audio" | "video" | "file";
  /** For text files: the file contents. */
  text?: string;
  /** For binary kinds: raw base64 (no data: prefix). */
  dataBase64?: string;
}

interface ChatSendPayload {
  sessionId?: string;
  message: string;
  /** Optional text-only history to seed a reopened session before the first send. */
  seed?: { role: "user" | "assistant"; content: string }[];
  /** Chat mode ("auto" | "plan" | "concise"). */
  mode?: string;
  attachments?: ChatAttachment[];
  /** Workspace ("home" | "code") — selects the advertised toolset. */
  space?: string;
  /** Reasoning effort ("low" | "medium" | "high"); absent = provider default. */
  effort?: EffortLevel;
}

/**
 * Input modalities of the ACTIVE MODEL (Settings → Providers → model).
 *
 * resolveProvider() fills these in from the model's own `modalities`, falling
 * back to what its id implies (inferModalities). The old fallback here keyed
 * off the provider's Base URL — `/anthropic\.com/` — which had nothing to do
 * with what the model could actually accept: the same GPT-4o was "blind"
 * behind a self-hosted gateway and sighted behind OpenRouter.
 *
 * A provider with no models[] at all (a config predating that field) still
 * needs an answer, and the model id is the only thing left to read.
 */
function activeModalities(): Set<string> {
  const p = getProviderManager().getActive();
  if (!p) return new Set(["text"]);
  if (p.modalities) return new Set(p.modalities);
  return new Set(inferModalities(p.kind, p.model ?? ""));
}

/**
 * Drop an attachment the model can't consume inline into the chat's file area
 * (Home → its sandbox; Code → the run's cwd) and return the note the model
 * sees. This is the "even if the model can't, still get the data to it" path:
 * a vision-blind model can't SEE a PNG, but it can run OCR on the saved file;
 * any model can read a saved PDF/CSV with its file tools.
 */
async function stashUnsupported(
  a: ChatAttachment,
  space: string | undefined,
  sessionId: string,
): Promise<string> {
  const kindWord =
    a.kind === "image" ? "view images"
    : a.kind === "audio" ? "hear audio"
    : a.kind === "video" ? "watch video"
    : "read this file inline";
  try {
    const bytes = Buffer.from(a.dataBase64 ?? "", "base64");
    if (bytes.length === 0) throw new Error("empty");
    const safeName = a.name.replace(/[^\p{L}\p{N}._-]/gu, "_") || "attachment";
    let savedPath: string | null;
    if (space === "home") {
      const { copyBufferIntoSandbox } = await import("../sandbox/files.js");
      savedPath = copyBufferIntoSandbox(sessionId, safeName, bytes);
    } else {
      // Code: write next to the workspace the run operates in.
      const { writeFile, mkdir } = await import("fs/promises");
      const { join } = await import("path");
      const dir = join(getWorkspacePath(), ".monet-attachments");
      await mkdir(dir, { recursive: true });
      const full = join(dir, safeName);
      await writeFile(full, bytes);
      savedPath = full;
    }
    if (!savedPath) throw new Error("could not save");
    const how =
      a.kind === "image"
        ? "run OCR / an image tool on it in the sandbox"
        : "read it with your file tools";
    return `\n\n[Attached ${a.kind}: ${a.name} — this model can't ${kindWord}, so it was saved to \`${savedPath}\`. To use its contents, ${how}.]`;
  } catch {
    return `\n\n[Attached ${a.kind}: ${a.name} — this model can't ${kindWord}, and it couldn't be saved to the workspace.]`;
  }
}

async function buildUserContent(
  message: string,
  attachments: ChatAttachment[] | undefined,
  space: string | undefined,
  sessionId: string,
): Promise<string | LLMContentBlock[]> {
  if (!attachments || attachments.length === 0) return message;

  const mods = activeModalities();
  const textParts: string[] = message ? [message] : [];
  const mediaBlocks: LLMContentBlock[] = [];

  const src = (
    a: ChatAttachment,
    fallbackMT: string,
  ): { type: "base64"; media_type: string; data: string } => ({
    type: "base64",
    media_type: a.mediaType || fallbackMT,
    data: a.dataBase64 ?? "",
  });

  for (const a of attachments) {
    if (a.kind === "text" && a.text != null) {
      textParts.push(`\n\n----- ${a.name} -----\n${a.text}`);
    } else if (a.kind === "image" && a.dataBase64) {
      if (mods.has("image"))
        mediaBlocks.push({ type: "image", source: src(a, "image/png") });
      else textParts.push(await stashUnsupported(a, space, sessionId));
    } else if (a.kind === "audio" && a.dataBase64) {
      if (mods.has("audio"))
        mediaBlocks.push({
          type: "audio",
          source: src(a, "audio/mpeg"),
          name: a.name,
        });
      else textParts.push(await stashUnsupported(a, space, sessionId));
    } else if (a.kind === "video" && a.dataBase64) {
      if (mods.has("video"))
        mediaBlocks.push({
          type: "video",
          source: src(a, "video/mp4"),
          name: a.name,
        });
      else textParts.push(await stashUnsupported(a, space, sessionId));
    } else if (a.kind === "file" && a.dataBase64) {
      if (mods.has("file"))
        mediaBlocks.push({
          type: "document",
          source: src(a, "application/pdf"),
          name: a.name,
        });
      else textParts.push(await stashUnsupported(a, space, sessionId));
    } else {
      textParts.push(`\n\n[Attached file: ${a.name}]`);
    }
  }

  const text = textParts.join("");
  if (mediaBlocks.length === 0) return text;
  return [{ type: "text", text }, ...mediaBlocks];
}

// The composer now sends a permission level (matching the vendor PermissionMode
// ids). Plan mode additionally steers the system prompt.
const VALID_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
]);

/**
 * The permission mode each running chat is under, right now.
 *
 * Reported: switching to Bypass mid-answer changed nothing and the app kept
 * asking. The mode travelled with the message and was captured for the whole
 * turn, so the picker only took effect on the NEXT one. This map is what the run
 * reads on every tool call instead.
 *
 * Keyed by session and never cleaned: one short string per chat, and a stale
 * entry is harmless — the next `chat:send` overwrites it, and nothing reads it
 * for a session that is not running.
 */
const livePermissionMode = new Map<string, UiPermissionMode>();

const MODE_DIRECTIVES: Record<string, string> = {
  plan: [
    "You are operating in PLAN mode: research first, change nothing. Read",
    "whatever you need to know exactly which files change and how; do NOT",
    "modify files or run mutating commands.",
    "",
    "When the plan is ready, present it by CALLING the ExitPlanMode tool —",
    "title, one-line summary, the detailed markdown, and a todo list of",
    "checkable work units. Do not paste the plan as a chat message instead",
    "of calling the tool: the tool is what shows the user the plan card and",
    "asks them to approve it. If they approve, start working through it; if",
    "they send it back, revise and call ExitPlanMode again.",
  ].join("\n"),
};

/** The mode directive for `mode`, tunable via <dataDir>/prompts/mode-<mode>.md. */
function modeDirectiveFor(mode: string): string | undefined {
  const def = MODE_DIRECTIVES[mode];
  return def ? tunablePrompt(`mode-${mode}`, def) : undefined;
}

// Per-session abort controllers so multiple chats can run (and be stopped)
// independently, and so switching chats doesn't cancel a background run.
const aborts = new Map<string, AbortController>();

/**
 * Auto-name a fresh chat after its first completed exchange: a small
 * complete() call produces a 3-6 word title (in the user's language), the DB
 * row is renamed, and the renderer is notified so the header and sidebar
 * update. Fire-and-forget — a failure just leaves "New Session".
 */
async function maybeAutoTitle(
  win: BrowserWindow,
  sessionId: string,
  firstMessage: string,
): Promise<void> {
  try {
    if (
      !sessionId ||
      sessionId === "default" ||
      sessionId.startsWith("incognito-")
    )
      return;
    const store = getSessionStore();
    const existing = store.get(sessionId);
    if (!existing || (existing.title && existing.title !== "New Session"))
      return;
    const provider = getProviderManager().getActive();
    if (!provider) return;
    const adapter = createAdapter(provider);
    const res = await adapter.complete({
      model: provider.model,
      system:
        "You name chat conversations. Reply with ONLY a concise 3-6 word title in the language of the message. No quotes, no trailing punctuation.",
      messages: [
        {
          role: "user",
          content: `Name this chat. Its first message:\n\n${firstMessage.slice(0, 500)}`,
        },
      ],
      max_tokens: 24,
    });
    const title = (typeof res.content === "string" ? res.content : "")
      .trim()
      .replace(/^["'«]+|["'»]+$/g, "")
      .split("\n")[0]
      .slice(0, 60);
    if (!title) return;
    store.updateTitle(sessionId, title);
    win.webContents.send("sessions:titleChanged", { sessionId, title });
  } catch {
    /* cosmetic — keep "New Session" */
  }
}

export function registerChatIPC(): void {
  ipcMain.handle("chat:send", async (_event, payload: ChatSendPayload) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No window");

    const sessionId = payload.sessionId || "default";
    // Prefer the durable full-fidelity transcript (tool blocks included); the
    // renderer's text-only `seed` is only a fallback for chats that have none
    // (seedConversation is a no-op once the transcript is loaded).
    await ensureTranscriptLoaded(sessionId);
    if (payload.seed && payload.seed.length > 0) {
      seedConversation(sessionId, payload.seed);
    }

    // Continuing a chat is what clears the mark it wears for having failed.
    // Here rather than on the first token: the user pressed send, so the
    // trouble is theirs to see again if it repeats.
    getSessionStore().setLastError(sessionId, null);

    // A new send for the same session supersedes its previous run.
    aborts.get(sessionId)?.abort();
    const abort = new AbortController();
    aborts.set(sessionId, abort);

    // Resolve this session's working directory from the per-session column
    // (set at create time, updated by the workspace picker on every folder
    // change), which is authoritative. Fall back to the global for legacy
    // sessions that predate the workspace column. This avoids the race where
    // the renderer's fire-and-forget workspace:set on session-open hasn't
    // landed yet.
    const sessionRow = getSessionStore().get(sessionId);
    const cwd = sessionRow?.workspace || getWorkspacePath();

    const mode =
      payload.mode && VALID_MODES.has(payload.mode)
        ? (payload.mode as
            | "default"
            | "acceptEdits"
            | "plan"
            | "auto"
            | "bypassPermissions")
        : "default";

    // Slash commands expand client-side, like the CLI: "/name args" becomes
    // the command's prompt. Unknown commands go through as plain text.
    let message = payload.message;

    // `/goal <objective>` starts an autonomous goal. Handled before the
    // ordinary expansion because it is not a prompt template: it writes a
    // record, and THIS send becomes the goal's first turn.
    const goalMatch = message.trim().match(/^\/goal\s+([\s\S]+)$/i);
    if (goalMatch) {
      const { registerGoalFromChat } = await import("./goal.js");
      const started = registerGoalFromChat(sessionId, goalMatch[1]!);
      if (!started.ok) {
        win.webContents.send("chat:token", {
          sessionId,
          event: { type: "error", error: started.error },
        });
        return { ok: false };
      }
      message = goalMatch[1]!;
    } else if (message.trimStart().startsWith("/")) {
      const expanded = await expandSlashCommand(message.trim());
      if (expanded) message = expanded;
    }

    const emit = (event: unknown): void => {
      // A turn that ends badly is remembered by the DATABASE, not just by the
      // renderer: the chat that fails while the user is in another one — or
      // while the app is closed afterwards — is the whole reason the mark
      // exists. A user-pressed Stop is not a failure.
      const e = event as { type?: string; error?: string };
      if (e?.type === "error" && e.error && e.error !== "Aborted")
        getSessionStore().setLastError(sessionId, e.error);
      // Tag every event with its session so the renderer routes it to the
      // right chat even after the user switched away.
      win.webContents.send("chat:token", { sessionId, event });
    };

    // The mode the picker is showing RIGHT NOW, not the one it showed when this
    // message was sent. Switching to Bypass mid-answer used to change nothing
    // until the next message, because the value was captured here.
    livePermissionMode.set(sessionId, mode);

    const runOptions = {
      signal: abort.signal,
      modeDirective: modeDirectiveFor(mode),
      permissionMode: () => livePermissionMode.get(sessionId) ?? mode,
      requestPermission: (ask: Parameters<typeof requestPermissionFromRenderer>[1]) =>
        requestPermissionFromRenderer(win, ask),
      askUser: (questions: Parameters<typeof askUserFromRenderer>[1]) =>
        askUserFromRenderer(win, questions),
      askPlanApproval: (
        plan: Parameters<typeof askPlanApprovalFromRenderer>[1],
        planId?: string,
      ) => askPlanApprovalFromRenderer(win, plan, planId, sessionId),
      space: payload.space,
      cwd,
      effort: payload.effort,
    };

    try {
      await runAgent(
        sessionId,
        await buildUserContent(
          message,
          payload.attachments,
          payload.space,
          sessionId,
        ),
        emit,
        runOptions,
      );

      // Goal mode: while the session's objective is still active, keep taking
      // turns. The driver owns every exit — see agent/goal/driver.ts. Sits
      // HERE rather than inside runAgent so a goal turn is an ordinary turn,
      // with the same permissions, checkpoints and transcript handling.
      const { driveGoal } = await import("../agent/goal/driver.js");
      const { loadGoal } = await import("../agent/goal/store.js");
      const hadGoal = loadGoal(sessionId) != null;
      if (loadGoal(sessionId)?.status === "active") {
        await driveGoal(
          (prompt) => runAgent(sessionId, prompt, emit, runOptions),
          {
            sessionId,
            tokensForLastTurn: () => lastTurnTokens(sessionId),
            isAborted: () => abort.signal.aborted,
            onGoalEvent: emit,
          },
        );
      }

      // The verification loop: after a turn that edited files, run the
      // project's own checks and bounce any failure back as another turn —
      // see verify/loop.ts. Not in Home (no workspace to check), and not on
      // goal runs, where the goal driver owns continuation and the judge
      // owns completion.
      if (
        !hadGoal &&
        payload.space !== "home" &&
        !abort.signal.aborted &&
        lastRunEditedFiles(sessionId).length > 0
      ) {
        const { getVerifyConfig, knownRedFor } = await import("../verify/state.js");
        const cfg = getVerifyConfig();
        if (cfg.enabled) {
          const { runVerifyLoop } = await import("../verify/loop.js");
          const outcome = await runVerifyLoop({
            cwd,
            runTurn: (prompt) => runAgent(sessionId, prompt, emit, runOptions),
            isAborted: () => abort.signal.aborted,
            emit,
            maxAttempts: cfg.maxAttempts,
            knownRed: knownRedFor(cwd),
          });
          // A loop that gave up leaves the same amber mark a failed turn does —
          // the chat needs the user, and the sidebar should say so.
          if (outcome.status === "gave-up")
            getSessionStore().setLastError(
              sessionId,
              `Verification: ${outcome.failure?.check ?? "checks"} still failing`,
            );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      getSessionStore().setLastError(sessionId, message);
      win.webContents.send("chat:token", {
        sessionId,
        event: { type: "error", error: message },
      });
    } finally {
      if (aborts.get(sessionId) === abort) aborts.delete(sessionId);
    }

    // First completed exchange names the chat (uses the ORIGINAL message,
    // not the slash-expanded one).
    void maybeAutoTitle(win, sessionId, payload.message);

    // Background memory extraction (Settings → Memory, throttled, best-effort).
    void (async () => {
      const { getConversationText } = await import("../agent/index.js");
      const { maybeExtractMemory } = await import("../memory/extract.js");
      await maybeExtractMemory(sessionId, getConversationText(sessionId));
    })().catch(() => {});

    return { ok: true };
  });

  /**
   * The picker moved. Takes effect on the next tool call of a turn already in
   * flight, which is the whole point — a mode you have to send a message to
   * apply is a mode that looks broken.
   */
  ipcMain.handle(
    "chat:setPermissionMode",
    (_e, sessionId: string, mode: string): { ok: boolean } => {
      if (!sessionId || !VALID_MODES.has(mode)) return { ok: false };
      // Narrowed by VALID_MODES, which is the same set the union is built from.
      livePermissionMode.set(sessionId, mode as UiPermissionMode);
      // A mode the user picked by hand ends any override the MODEL set
      // (EnterPlanMode, or approving a plan). Without this, choosing the same
      // value the override was recorded under — "Manually approve" while the
      // model had switched the chat to plan — left plan mode on with no way
      // to leave it.
      clearSessionMode(sessionId);
      return { ok: true };
    },
  );

  ipcMain.handle("chat:abort", (_e, sessionId?: string) => {
    if (sessionId) {
      abortBgAgents(sessionId);
      const a = aborts.get(sessionId);
      if (a) {
        a.abort();
        aborts.delete(sessionId);
        return { ok: true };
      }
      return { ok: false, error: "No active request for session" };
    }
    // No id → abort everything.
    abortAllBgAgents();
    for (const a of aborts.values()) a.abort();
    aborts.clear();
    return { ok: true };
  });

  // Hand text to a turn that is already running. Returns ok:false when the
  // session is idle so the renderer sends it normally instead — the user
  // pressed a key and something has to happen either way.
  ipcMain.handle(
    "chat:inject",
    (_e, sessionId: string, text: string): { ok: boolean } => ({
      ok: injectMessage(sessionId, text),
    }),
  );

  // Drop the last N prompts from the model's context. Files are untouched —
  // that is the checkpoint rewind, a different question.
  ipcMain.handle(
    "chat:undoPrompts",
    async (_e, sessionId: string, count?: number) =>
      undoPrompts(sessionId || "default", count ?? 1),
  );

  ipcMain.handle("chat:undoableTurns", async (_e, sessionId?: string) =>
    undoableTurnCount(sessionId || "default"),
  );

  ipcMain.handle("chat:reset", (_event, sessionId?: string) => {
    abortBgAgents(sessionId || "default");
    resetConversation(sessionId || "default");
    return { ok: true };
  });

  // Full-fidelity rewind: truncate the durable transcript to keep the first N
  // user turns (tool blocks intact), instead of clearing + reseeding as text.
  ipcMain.handle(
    "chat:forkTranscript",
    (
      _e,
      fromSessionId: string,
      toSessionId: string,
      keepUserTurns?: number,
      totalUserTurns?: number,
    ) =>
      forkTranscriptToSession(
        fromSessionId || "default",
        toSessionId,
        keepUserTurns,
        totalUserTurns,
      ),
  );

  ipcMain.handle(
    "chat:rewindTranscript",
    async (
      _e,
      sessionId: string,
      keepUserTurns: number,
      totalUserTurns?: number,
    ) => {
      abortBgAgents(sessionId || "default");
      return rewindTranscriptToUserTurn(
        sessionId || "default",
        keepUserTurns,
        totalUserTurns,
      );
    },
  );

  // Manual compaction — used when switching to a model with a smaller
  // context window than the current conversation.
  ipcMain.handle("chat:compact", async (_e, sessionId?: string) => {
    try {
      const result = await compactSessionNow(sessionId || "default");
      return result
        ? { ok: true, ...result }
        : { ok: false, error: "Nothing to compact" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Compaction failed",
      };
    }
  });

  // Rough token estimate of a session's in-memory history.
  ipcMain.handle("chat:estimate", (_e, sessionId?: string) => {
    return { tokens: estimateSessionTokens(sessionId || "default") };
  });

  // Context-change history (compactions, rewinds) for a session — powers the
  // "rewind through compact" affordance.
  ipcMain.handle("chat:contextEvents", async (_e, sessionId?: string) => {
    const { listContextEvents } = await import("../transcript-store.js");
    // Strip the heavy before/after snapshots — the UI only needs the summary.
    return listContextEvents(sessionId || "default").map((ev) => ({
      id: ev.id,
      type: ev.type,
      at: ev.at,
      manual: ev.payload.manual === true,
      beforeTokens: (ev.payload.beforeTokens as number) ?? null,
      afterTokens: (ev.payload.afterTokens as number) ?? null,
    }));
  });

  // Undo a compaction: restore the pre-compaction context ("rewind through
  // compact"). The renderer re-seeds its display from the restored history.
  ipcMain.handle(
    "chat:undoCompact",
    async (_e, sessionId: string, eventId: string) => {
      try {
        const r = await undoCompaction(sessionId || "default", eventId);
        return r ? { ok: true, ...r } : { ok: false, error: "Nothing to undo" };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Undo failed",
        };
      }
    },
  );

  // Per-category breakdown of what fills the context window right now.
  ipcMain.handle(
    "chat:contextBreakdown",
    (_e, sessionId?: string, space?: string, messageTokens?: number) =>
      computeContextBreakdown(sessionId || "default", space, messageTokens),
  );

  // Code Rewind: restore the workspace to a turn's checkpoint (shadow git).
  ipcMain.handle(
    "checkpoints:rewind",
    async (_e, sessionId: string, sha: string) => {
      const { rewindWorkspace } = await import("../agent/checkpoints.js");
      const { getWorkspacePath } = await import("./workspace.js");
      return rewindWorkspace(sessionId || "default", getWorkspacePath(), sha);
    },
  );

  // Code Rewind preview: how much a rewind to this checkpoint would undo.
  ipcMain.handle(
    "checkpoints:diffStat",
    async (_e, sessionId: string, sha: string) => {
      const { checkpointDiffStat } = await import("../agent/checkpoints.js");
      const { getWorkspacePath } = await import("./workspace.js");
      return checkpointDiffStat(sessionId || "default", getWorkspacePath(), sha);
    },
  );
}
