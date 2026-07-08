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
} from "../agent/index.js";
import { getProviderManager } from "../provider/manager.js";
import { requestPermissionFromRenderer } from "./permissions.js";
import type { LLMContentBlock } from "../llm/adapter.js";

interface ChatAttachment {
  name: string;
  mediaType: string;
  kind: "text" | "image";
  /** For text files: the file contents. */
  text?: string;
  /** For images: raw base64 (no data: prefix). */
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
}

function providerSupportsVision(): boolean {
  const p = getProviderManager().getActive();
  // Only real Anthropic endpoints are treated as vision-capable for now.
  return !!p && /anthropic\.com/i.test(p.baseURL);
}

function buildUserContent(
  message: string,
  attachments: ChatAttachment[] | undefined,
): string | LLMContentBlock[] {
  if (!attachments || attachments.length === 0) return message;

  const vision = providerSupportsVision();
  const textParts: string[] = message ? [message] : [];
  const imageBlocks: LLMContentBlock[] = [];

  for (const a of attachments) {
    if (a.kind === "text" && a.text != null) {
      textParts.push(`\n\n----- ${a.name} -----\n${a.text}`);
    } else if (a.kind === "image" && a.dataBase64) {
      if (vision) {
        imageBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: a.mediaType || "image/png",
            data: a.dataBase64,
          },
        });
      } else {
        textParts.push(
          `\n\n[Attached image: ${a.name} — the current model can't view images]`,
        );
      }
    } else {
      textParts.push(`\n\n[Attached file: ${a.name}]`);
    }
  }

  const text = textParts.join("");
  if (imageBlocks.length === 0) return text;
  return [{ type: "text", text }, ...imageBlocks];
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

    try {
      await runAgent(
        sessionId,
        buildUserContent(payload.message, payload.attachments),
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

    return { ok: true };
  });

  ipcMain.handle("chat:abort", (_e, sessionId?: string) => {
    if (sessionId) {
      const a = aborts.get(sessionId);
      if (a) {
        a.abort();
        aborts.delete(sessionId);
        return { ok: true };
      }
      return { ok: false, error: "No active request for session" };
    }
    // No id → abort everything.
    for (const a of aborts.values()) a.abort();
    aborts.clear();
    return { ok: true };
  });

  ipcMain.handle("chat:reset", (_event, sessionId?: string) => {
    resetConversation(sessionId || "default");
    return { ok: true };
  });
}
