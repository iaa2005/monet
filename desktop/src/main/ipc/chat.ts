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
  compactSessionNow,
  estimateSessionTokens,
  computeContextBreakdown,
} from "../agent/index.js";
import { expandSlashCommand } from "../agent/skill-tool.js";
import { abortAllBgAgents, abortBgAgents } from "../agent/bg-agents.js";
import { getSessionStore } from "../session-store.js";
import { createAdapter } from "../llm/adapter.js";
import { getProviderManager } from "../provider/manager.js";
import type { EffortLevel } from "../provider/types.js";
import { requestPermissionFromRenderer } from "./permissions.js";
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

/** Input modalities of the ACTIVE MODEL (Settings → Providers → model).
 * Legacy configs without flags fall back to the old vision heuristic. */
function activeModalities(): Set<string> {
  const p = getProviderManager().getActive();
  if (!p) return new Set(["text"]);
  if (p.modalities) return new Set(p.modalities);
  const vision = /anthropic\.com/i.test(p.baseURL) || p.kind === "openrouter";
  return new Set(vision ? ["text", "image"] : ["text"]);
}

function buildUserContent(
  message: string,
  attachments: ChatAttachment[] | undefined,
): string | LLMContentBlock[] {
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
      else
        textParts.push(
          `\n\n[Attached image: ${a.name} — the current model can't view images]`,
        );
    } else if (a.kind === "audio" && a.dataBase64) {
      if (mods.has("audio"))
        mediaBlocks.push({
          type: "audio",
          source: src(a, "audio/mpeg"),
          name: a.name,
        });
      else
        textParts.push(
          `\n\n[Attached audio: ${a.name} — the current model can't hear audio]`,
        );
    } else if (a.kind === "video" && a.dataBase64) {
      if (mods.has("video"))
        mediaBlocks.push({
          type: "video",
          source: src(a, "video/mp4"),
          name: a.name,
        });
      else
        textParts.push(
          `\n\n[Attached video: ${a.name} — the current model can't watch video]`,
        );
    } else if (a.kind === "file" && a.dataBase64) {
      if (mods.has("file"))
        mediaBlocks.push({
          type: "document",
          source: src(a, "application/pdf"),
          name: a.name,
        });
      else
        textParts.push(
          `\n\n[Attached document: ${a.name} — the current model can't read files]`,
        );
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

const MODE_DIRECTIVES: Record<string, string> = {
  plan: "You are operating in PLAN mode: think through the task and present a clear, numbered plan first. Do NOT modify files or run mutating commands until the user approves the plan.",
};

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
    if (payload.seed && payload.seed.length > 0) {
      seedConversation(sessionId, payload.seed);
    }

    // A new send for the same session supersedes its previous run.
    aborts.get(sessionId)?.abort();
    const abort = new AbortController();
    aborts.set(sessionId, abort);

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
    if (message.trimStart().startsWith("/")) {
      const expanded = await expandSlashCommand(message.trim());
      if (expanded) message = expanded;
    }

    try {
      await runAgent(
        sessionId,
        buildUserContent(message, payload.attachments),
        (event) => {
          // Tag every event with its session so the renderer routes it to the
          // right chat even after the user switched away.
          win.webContents.send("chat:token", { sessionId, event });
        },
        {
          signal: abort.signal,
          modeDirective: MODE_DIRECTIVES[mode],
          permissionMode: mode,
          requestPermission: (ask) => requestPermissionFromRenderer(win, ask),
          space: payload.space,
          effort: payload.effort,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
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

    return { ok: true };
  });

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

  ipcMain.handle("chat:reset", (_event, sessionId?: string) => {
    abortBgAgents(sessionId || "default");
    resetConversation(sessionId || "default");
    return { ok: true };
  });

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
