/**
 * Chat IPC handler — streaming chat:send + chat:abort + chat:reset.
 *
 * Uses the agent wrapper, which keeps per-session conversation history so the
 * chat is multi-turn.
 */

import { ipcMain, BrowserWindow } from "electron";
import { isUntitled, cleanTitle, TITLE_PLACEHOLDER } from "../session/auto-title.js";
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
import { stopReasonLabel } from "../agent/empty-turn.js";
import { expandSlashCommand } from "../agent/skill-tool.js";
import { abortAllBgAgents, abortBgAgents } from "../agent/bg-agents.js";
import { getSessionStore } from "../session/store.js";
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
import { sandboxWorkDir } from "../sandbox/podman-engine.js";
import { setVisibleChatSession } from "../session/visible.js";
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
  /** Voice Mode: the reply is spoken aloud by a voice of this gender. */
  voiceGender?: "female" | "male";
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

/**
 * The directive a SPOKEN run gets. Two things only a voice needs: gender
 * agreement (Russian first-person verbs carry it — a male voice saying
 * "я закончила" is absurd), and the expression tags the synthesiser
 * understands. Tunable via <dataDir>/prompts/voice-mode-<gender>.md.
 */
function voiceDirectiveFor(
  gender: "female" | "male" | undefined,
): string | undefined {
  if (!gender) return undefined;
  // Concrete forms, not descriptions: "agree first-person gender" slid
  // right past DeepSeek, «говори „я сделал“» does not.
  const forms =
    gender === "female"
      ? "«я сделала», «я закончила», «я готова»"
      : "«я сделал», «я закончил», «я готов»";
  // One tunable key PER GENDER: tunablePrompt caches by key, and a single
  // "voice-mode" key froze whichever gender happened to run first — the male
  // voice spent a day introducing itself in the feminine.
  return tunablePrompt(
    `voice-mode-${gender}`,
    [
      `Your reply is read aloud by a ${gender} voice. In Russian, ALWAYS use`,
      `${gender} first-person forms: ${forms}. This is mandatory.`,
      "Speak briefly and conversationally — a few sentences, no headings,",
      "no code blocks, no markdown lists. You may use spoken-expression",
      "tags, ALWAYS doubled and ONLY at the start of a sentence or right",
      "after its final period: <laugh><laugh>, <breath><breath>,",
      "<sigh><sigh>, <cough><cough>, <sad><sad>. The listener hears them",
      "performed, never sees them. Never OPEN a paragraph with <breath> or",
      "<sigh> — those get read aloud there; a paragraph may open with",
      "<laugh><laugh>. Never place a tag mid-sentence — it is",
      "ignored there. In Russian you may also use <sad><sad> and a scream",
      "wrapping a short interjection: <scream> Ааа <scream>. When speaking",
      "any OTHER language, stick to laugh, breath and cough only — <sad>",
      "and <scream> get read aloud as words there (field-tested in",
      "French). Do NOT use <surprise>, <angry>, <yawn> or <throatclear>",
      "anywhere — the voice reads those aloud as English words. Use tags",
      "sparingly, where a real person would actually react.",
    ].join(String.fromCharCode(10)),
  );
}

/**
 * The chat the renderer currently has on screen, as the renderer last said.
 *
 * Main cannot see this and it decides whether a finished turn is worth a
 * desktop notification: an answer that arrived in the chat you are reading is
 * not news. Undefined means the renderer has not told us yet, which reads as
 * "no chat is visible" — the safe side, since the worst case is one extra
 * notification rather than a silent one that was needed.
 */
let visibleSessionId: string | undefined;

/** The chat the user is looking at, as the renderer last reported. The
 * browser layer uses it to decide whether a run's page may live in the
 * visible panel or must stay in the hidden layer. */
export function getVisibleChatSession(): string | undefined {
  return visibleSessionId;
}

// Per-session abort controllers so multiple chats can run (and be stopped)
// independently, and so switching chats doesn't cancel a background run.
const aborts = new Map<string, AbortController>();

/**
 * Auto-name a fresh chat after its first completed exchange: a small
 * complete() call produces a 3-6 word title (in the user's language), the DB
 * row is renamed, and the renderer is notified so the header and sidebar
 * update. Fire-and-forget — a failure just leaves "New Session".
 *
 * `wasUntitled` is read at the START of the turn, not here, and that is the
 * whole point: the renderer saves the chat mid-stream and stamps a provisional
 * title on it — the first 60 characters of the user's message. Deciding here
 * meant finding that stamp already in place and concluding the chat had a
 * name, so no chat was ever renamed and every one of them was called by its
 * own opening line. A rename the user typed happened before the turn and is
 * therefore still respected.
 */
async function maybeAutoTitle(
  win: BrowserWindow,
  sessionId: string,
  firstMessage: string,
  wasUntitled: boolean,
): Promise<void> {
  try {
    if (
      !sessionId ||
      sessionId === "default" ||
      sessionId.startsWith("incognito-")
    )
      return;
    const store = getSessionStore();
    if (!wasUntitled || !store.get(sessionId)) return;
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
      // A reasoning model spends its budget thinking before it answers, and
      // the old 24 tokens bought nothing but a truncated thought: the reply
      // came back literally empty, so no chat was ever renamed. Measured on
      // deepseek-v4-pro — 256 was still empty for a two-clause first message,
      // 1024 lands it. Four words cost nothing; a nameless chat costs a name.
      effort: "minimal",
      max_tokens: 1024,
    });
    const title = cleanTitle(res.content);
    if (!title) return;
    store.updateTitle(sessionId, title);
    win.webContents.send("sessions:titleChanged", { sessionId, title });
  } catch {
    /* cosmetic — keep the provisional name */
  }
}

export function registerChatIPC(): void {
  ipcMain.handle("chat:send", async (_event, payload: ChatSendPayload) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No window");

    const sessionId = payload.sessionId || "default";
    // Read BEFORE anything runs: by the time the turn ends the renderer has
    // saved the chat with a provisional title taken from this very message,
    // and nothing downstream could still tell a fresh chat from a named one.
    const wasUntitled = isUntitled(getSessionStore().get(sessionId)?.title);
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
    // Home never sees the Code workspace: its run's cwd IS the chat's sandbox.
    // The global path used to leak into the prompt's env block here, and the
    // model announced a folder its Home tools could not even touch.
    const cwd =
      payload.space === "home"
        ? sandboxWorkDir(sessionId)
        : sessionRow?.workspace || getWorkspacePath();

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

    /** The reply so far, for the first line of a notification the user may
     * never need. Per send, so it cannot leak between turns. */
    let replyText = "";

    const emit = (event: unknown): void => {
      // A turn that ends badly is remembered by the DATABASE, not just by the
      // renderer: the chat that fails while the user is in another one — or
      // while the app is closed afterwards — is the whole reason the mark
      // exists. A user-pressed Stop is not a failure.
      const e = event as {
        type?: string;
        error?: string;
        stop_reason?: string;
        empty?: boolean;
        text?: string;
      };
      if (e?.type === "error" && e.error && e.error !== "Aborted")
        getSessionStore().setLastError(sessionId, e.error);
      // The reply as it streams, kept only to put its first line in a
      // notification the user may never need — cleared with the turn.
      if (e?.type === "text_delta" && e.text) replyText += e.text;
      // How the turn ended, kept for the same reason: a run that comes back
      // with nothing leaves no other trace, so "gave up" and "finished" look
      // identical afterwards. See agent/empty-turn.ts.
      if (e?.type === "message_stop")
        getSessionStore().setLastStopReason(
          sessionId,
          stopReasonLabel(e.stop_reason, e.empty === true),
        );
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
      modeDirective:
        [modeDirectiveFor(mode), voiceDirectiveFor(payload.voiceGender)]
          .filter(Boolean)
          .join("\n\n") || undefined,
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
    // not the slash-expanded one). Started before the notification and awaited
    // by it: the first turn of a new chat is exactly the one whose toast has
    // nothing to call it yet.
    const titling = maybeAutoTitle(
      win,
      sessionId,
      payload.message,
      wasUntitled,
    );

    // The turn is over. Tell the user only if they could not have seen it —
    // see app/turn-notify.ts for every case, and for why a routine never counts.
    void (async () => {
      try {
        const { shouldNotifyTurnEnd, notificationBody } = await import(
          "../app/turn-notify.js"
        );
        const store = getSessionStore();
        const decision = shouldNotifyTurnEnd({
          sessionId,
          visibleSessionId,
          windowFocused: !win.isDestroyed() && win.isFocused() && !win.isMinimized(),
          windowVisible: !win.isDestroyed() && win.isVisible(),
          isRoutineChat: !!store.routineIdOf(sessionId),
          aborted: abort.signal.aborted,
        });
        if (!decision.notify) return;
        const { Notification } = await import("electron");
        if (!Notification.isSupported()) return;
        // No `icon`: on Windows that is appLogoOverride — the big round
        // picture beside the text — while the small logo next to the app name
        // comes from the Start Menu shortcut the installer writes with this
        // AppUserModelID. Two pictures of the same thing, one of them huge.
        // The chat's name is worth waiting for: the first turn of a new chat
        // is exactly the one whose toast has nothing to call it yet.
        await titling.catch(() => {});
        const row = store.get(sessionId);
        const n = new Notification({
          title: row?.title || TITLE_PLACEHOLDER,
          body: notificationBody(replyText, row?.lastError),
          silent: false,
        });
        // Clicking it does the obvious thing: bring the app up on that chat.
        n.on("click", () => {
          if (win.isDestroyed()) return;
          if (!win.isVisible()) win.show();
          if (win.isMinimized()) win.restore();
          win.focus();
          win.webContents.send("chat:focusSession", sessionId);
        });
        n.show();
      } catch {
        /* a notification is never worth failing a turn over */
      }
    })();

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

  /** The renderer says which chat is on screen (and undefined when none is).
   * Read only when a turn ends — see the note on visibleSessionId. */
  ipcMain.handle(
    "chat:setVisibleSession",
    (_e, sessionId?: string): { ok: boolean } => {
      visibleSessionId = sessionId || undefined;
      setVisibleChatSession(visibleSessionId);
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

  // Hand text (and files) to a turn that is already running. Returns ok:false
  // when the session is idle so the renderer sends it normally instead — the
  // user pressed a key and something has to happen either way. Attachments go
  // through the SAME pipeline as a normal send (buildUserContent): images the
  // model can see ride as blocks, everything else is stashed to the sandbox /
  // workspace with a note saying where.
  ipcMain.handle(
    "chat:inject",
    async (
      _e,
      sessionId: string,
      text: string,
      attachments?: ChatAttachment[],
      space?: string,
    ): Promise<{ ok: boolean }> => {
      if (!attachments?.length) return { ok: injectMessage(sessionId, text) };
      const content = await buildUserContent(text, attachments, space, sessionId);
      if (typeof content === "string")
        return { ok: injectMessage(sessionId, content) };
      const [head, ...media] = content;
      const noteText = head?.type === "text" ? head.text : text;
      return { ok: injectMessage(sessionId, noteText, media) };
    },
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
    const { listContextEvents } = await import("../session/transcript.js");
    // Strip the heavy before/after snapshots — the UI only needs the summary.
    return listContextEvents(sessionId || "default").map((ev) => ({
      id: ev.id,
      type: ev.type,
      at: ev.at,
      manual: ev.payload.manual === true,
      beforeTokens: (ev.payload.beforeTokens as number) ?? null,
      afterTokens: (ev.payload.afterTokens as number) ?? null,
      // What the chat needs to draw the line the model reads from: turn
      // counts either side of the event, and how many turns earlier
      // compactions had already taken off the front. See lib/context-map.ts.
      undo: ev.payload.undo === true,
      userTurnsBefore: (ev.payload.userTurnsBefore as number) ?? null,
      userTurnsAfter: (ev.payload.userTurnsAfter as number) ?? null,
      headOffset: (ev.payload.headOffset as number) ?? null,
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
