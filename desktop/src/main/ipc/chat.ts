/**
 * Chat IPC handler — streaming chat:send + chat:abort.
 *
 * Uses the agent wrapper to orchestrate tool calls.
 */

import { ipcMain, BrowserWindow } from "electron";
import { runAgent } from "../agent/index.js";
import type { LLMRequest } from "../llm/adapter.js";

let currentAbort: AbortController | null = null;

export function registerChatIPC(): void {
  ipcMain.handle("chat:send", async (_event, request: LLMRequest) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) throw new Error("No window");

    const abort = new AbortController();
    currentAbort = abort;

    const userMsg = request.messages.filter((m) => m.role === "user").pop();
    if (!userMsg) {
      throw new Error("No user message in request");
    }

    const userText =
      typeof userMsg.content === "string"
        ? userMsg.content
        : userMsg.content
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");

    try {
      await runAgent(
        userText,
        (event) => {
          win.webContents.send("chat:token", event);
        },
        { signal: abort.signal },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      win.webContents.send("chat:token", { type: "error", error: message });
    } finally {
      currentAbort = null;
    }

    return { ok: true };
  });

  ipcMain.handle("chat:abort", () => {
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = null;
      return { ok: true };
    }
    return { ok: false, error: "No active request" };
  });
}
