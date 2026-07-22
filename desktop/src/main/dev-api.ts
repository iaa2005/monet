/**
 * Dev-only local API — drive the running app from outside it.
 *
 * Built for prompt/behaviour evaluation: an external process can start a real
 * chat and read the resulting transcript, using the SAME runAgent, provider
 * store, sandbox and prompts the UI uses. A separate harness that re-implements
 * the loop drifts from the app (ours did, three times), which makes its results
 * meaningless for tuning.
 *
 * SECURITY — this endpoint runs the agent, which runs code. Four gates:
 *  1. Off unless MONET_DEV_API=1 is set for the process.
 *  2. Refused outright in a packaged build.
 *  3. Bound to 127.0.0.1 only.
 *  4. Every request needs a bearer token, generated per boot and written to
 *     <dataDir>/dev-api.json (readable only by whoever can read the data dir).
 *     Without it a web page could reach this through DNS rebinding.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomBytes } from "crypto";
import { writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { app } from "electron";
import { getDataDir } from "./data-dir.js";
import { getSessionStore } from "./session-store.js";
import { loadTranscriptWithMeta } from "./transcript-store.js";
import { runAgent } from "./agent/index.js";
import type { LLMEvent } from "./llm/adapter.js";

const PORT = Number(process.env.MONET_DEV_API_PORT || 8765);

function infoPath(): string {
  return join(getDataDir(), "dev-api.json");
}

interface ChatBody {
  message: string;
  space?: "home" | "code";
  sessionId?: string;
  /** Defaults to bypassPermissions: there is no UI to answer a prompt here. */
  permissionMode?: "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";
  providerId?: string;
  model?: string;
  /** Working directory for a Code run. Defaults to <home>/monet-eval rather
   * than the user's selected workspace: an eval must not touch a real project
   * just because the picker happened to point at one. */
  cwd?: string;
  maxTurns?: number;
  /** Seconds before the run is abandoned (default 300). */
  timeout?: number;
}

/** Everything a caller needs to judge a run, in one payload. */
interface TurnStep {
  type: "text" | "reasoning" | "tool" | "tool_result" | "error";
  name?: string;
  input?: unknown;
  text?: string;
  isError?: boolean;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function handleChat(body: ChatBody): Promise<unknown> {
  const space = body.space === "home" ? "home" : "code";
  // runAgent pins this for the prompt AND every tool call, and it also keeps
  // the UI's workspace picker from deciding where an eval writes.
  const cwd =
    space === "code" ? body.cwd || join(homedir(), "monet-eval") : undefined;
  if (cwd) mkdirSync(cwd, { recursive: true });
  const store = getSessionStore();
  const sessionId =
    body.sessionId ||
    store.create(`eval: ${body.message.slice(0, 60)}`, space).id;

  const steps: TurnStep[] = [];
  let finalText = "";
  let stopReason = "";

  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(),
    Math.max(10, body.timeout ?? 300) * 1000,
  );

  const onEvent = (ev: LLMEvent): void => {
    switch (ev.type) {
      case "text_delta":
        finalText += ev.text;
        break;
      case "reasoning_delta": {
        const last = steps[steps.length - 1];
        if (last?.type === "reasoning") last.text = (last.text ?? "") + ev.text;
        else steps.push({ type: "reasoning", text: ev.text });
        break;
      }
      case "tool_use":
        // Flush the text that preceded this call so the order is readable.
        if (finalText.trim()) {
          steps.push({ type: "text", text: finalText });
          finalText = "";
        }
        steps.push({ type: "tool", name: ev.name, input: ev.input });
        break;
      case "tool_result":
        steps.push({
          type: "tool_result",
          name: ev.toolName,
          text: ev.content.slice(0, 4_000),
        });
        break;
      case "error":
        steps.push({ type: "error", text: ev.error });
        break;
      case "message_stop":
        stopReason = ev.stop_reason;
        break;
      default:
        break;
    }
  };

  try {
    await runAgent(sessionId, body.message, onEvent, {
      signal: abort.signal,
      space,
      cwd,
      permissionMode: body.permissionMode ?? "bypassPermissions",
      maxTurns: body.maxTurns ?? 24,
      providerId: body.providerId,
      modelOverride: body.model,
      // No UI is attached: a tool that needs a human is refused rather than
      // hanging the request until the timeout.
      requestPermission: async () => "deny",
      askUser: async () => ({ cancelled: true }),
      askPlanApproval: async () => ({ decision: "keep-planning" as const }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (finalText.trim()) steps.push({ type: "text", text: finalText });

  return {
    sessionId,
    space,
    cwd,
    stopReason,
    toolCalls: steps.filter((s) => s.type === "tool").length,
    steps,
  };
}

let server: ReturnType<typeof createServer> | null = null;

export function initDevApi(): void {
  if (process.env.MONET_DEV_API !== "1") return;
  if (app.isPackaged) {
    console.warn("[dev-api] refused: packaged build");
    return;
  }

  const token = randomBytes(24).toString("hex");

  server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.headers.authorization !== `Bearer ${token}`) {
          json(res, 401, { error: "bad token" });
          return;
        }
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const path = url.pathname.replace(/\/+$/, "") || "/";

        if (path === "/health") {
          json(res, 200, { ok: true, pid: process.pid });
          return;
        }
        if (path === "/sessions" && req.method === "GET") {
          const limit = Number(url.searchParams.get("limit") || 20);
          json(res, 200, getSessionStore().list(limit, 0));
          return;
        }
        if (path.startsWith("/sessions/") && req.method === "GET") {
          const id = decodeURIComponent(path.slice("/sessions/".length));
          const { messages } = loadTranscriptWithMeta(id);
          json(res, 200, { sessionId: id, messages });
          return;
        }
        if (path === "/chat" && req.method === "POST") {
          const body = JSON.parse((await readBody(req)) || "{}") as ChatBody;
          if (!body.message) {
            json(res, 400, { error: "message is required" });
            return;
          }
          json(res, 200, await handleChat(body));
          return;
        }
        json(res, 404, { error: `no route for ${req.method} ${path}` });
      } catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });

  server.listen(PORT, "127.0.0.1", () => {
    writeFileSync(
      infoPath(),
      JSON.stringify({ port: PORT, token, startedAt: new Date().toISOString() }, null, 2),
      "utf-8",
    );
    console.log(`[dev-api] listening on http://127.0.0.1:${PORT} (token in dev-api.json)`);
  });

  app.on("before-quit", () => {
    try {
      rmSync(infoPath(), { force: true });
    } catch {
      /* best-effort */
    }
    server?.close();
  });
}
