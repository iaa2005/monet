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
import { getDataDir } from "../data-dir.js";
import { getSessionStore } from "../session/store.js";
import {
  listContextEventSummaries,
  loadTranscriptWithMeta,
} from "../session/transcript.js";
import {
  compactSessionNow,
  messagesInContext,
  rewindTranscriptToUserTurn,
  runAgent,
  setTurnContext,
  turnContextState,
  undoCompaction,
} from "../agent/index.js";
import { estimateTokens } from "../agent/compaction.js";
import type { LLMEvent } from "../llm/adapter.js";

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
  /** Id for this prompt's bubble, so a later call can address the turn. */
  userMessageId?: string;
  /**
   * Include the user's long-term memory in the system prompt (default true).
   *
   * An eval that tells the model to remember a word, and then checks whether
   * it still knows it, is measuring the CONTEXT — so it has to turn this off.
   * Otherwise the model reaches for the Remember tool, the word lands in the
   * memory file, and every later session in that data dir knows it: the check
   * passes for a reason that has nothing to do with what it is checking.
   */
  memory?: boolean;
}

/** Everything a caller needs to judge a run, in one payload. */
interface TurnStep {
  type: "text" | "reasoning" | "tool" | "tool_result" | "error" | "harness";
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
  // The two handles a caller needs to address this turn afterwards: the id
  // the chat draws the bubble with (and setTurnContext takes), and the
  // commit the folder was at when the turn finished.
  const userMessageId = body.userMessageId || `dev-${randomBytes(6).toString("hex")}`;
  let checkpointSha = "";

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
        // Final results only: the placeholder and the progress updates share
        // this event type, and a transcript full of "Running…" is noise in
        // exactly the artefact prompt evaluation reads.
        if (ev.final)
          steps.push({
            type: "tool_result",
            name: ev.toolName,
            text: ev.content.slice(0, 4_000),
          });
        break;
      case "error":
        steps.push({ type: "error", text: ev.error });
        break;
      // What the HARNESS did on its own — the reconnaissance phase, the
      // second reader, the smoke run. Without these a harness step is
      // invisible to anything driving the app from outside, and the only
      // evidence it ran is a side effect somebody has to infer.
      case "harness":
        steps.push({ type: "harness", text: ev.text });
        break;
      case "message_stop":
        stopReason = ev.stop_reason;
        break;
      case "checkpoint":
        checkpointSha = ev.sha;
        break;
      default:
        break;
    }
  };

  // The same baseline the chat captures, so the second reader sees only
  // what this turn changed.
  const { captureReviewBaseline, clarifyBeforeTurn, runPostTurnChecks } =
    await import("../verify/post-turn.js");
  const reviewBaseline = await captureReviewBaseline(sessionId, cwd, space);

  // The same question the chat asks. Nothing here can answer a dialog, so a
  // run driven from outside sees the reader decide and then proceed — which
  // is the behaviour worth checking: an unanswered question costs no turn.
  const clarifyNote = await clarifyBeforeTurn({
    message: body.message,
    space,
    firstPrompt: !body.sessionId,
    ask: async () => ({ cancelled: true as const }),
    emit: onEvent,
    signal: abort.signal,
  });

  const runOptions = {
    signal: abort.signal,
    space,
    cwd,
    userMessageId,
    memory: body.memory,
    permissionMode: body.permissionMode ?? "bypassPermissions",
    maxTurns: body.maxTurns ?? 24,
    providerId: body.providerId,
    modelOverride: body.model,
    // No UI is attached: a tool that needs a human is refused rather than
    // hanging the request until the timeout.
    requestPermission: async () => "deny" as const,
    askUser: async () => ({ cancelled: true as const }),
    askPlanApproval: async () => ({ decision: "keep-planning" as const }),
  };

  try {
    await runAgent(sessionId, body.message + clarifyNote, onEvent, runOptions);
    // Whatever the harness does after a turn, it does here too — otherwise
    // a harness driving the app from outside cannot see the features it is
    // there to measure. One implementation: verify/post-turn.ts.
    await runPostTurnChecks({
      sessionId,
      cwd,
      space,
      reviewBaseline,
      runTurn: (prompt) => runAgent(sessionId, prompt, onEvent, runOptions),
      emit: onEvent,
      isAborted: () => abort.signal.aborted,
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
    userMessageId,
    checkpointSha,
    text: steps
      .filter((s) => s.type === "text")
      .map((s) => s.text ?? "")
      .join("\n"),
    toolCalls: steps.filter((s) => s.type === "tool").length,
    steps,
  };
}

/**
 * What the model is actually being sent, and what it no longer is.
 *
 * The same three numbers the context meter draws, from the same functions,
 * so a harness can check the meter's arithmetic against the transcript on
 * disk rather than against a second implementation of it.
 */
function contextReport(sessionId: string): unknown {
  const live = messagesInContext(sessionId);
  const { messages, inContext, ids } = loadTranscriptWithMeta(sessionId);
  return {
    sessionId,
    turns: turnContextState(sessionId),
    // In memory (what the next request is built from)…
    inContextMessages: live.length,
    inContextTokens: estimateTokens(live),
    // …against everything the chat holds, removed turns included. The two
    // differ by exactly what the user has taken out, which is the number a
    // meter has to be able to show.
    allTokens: estimateTokens(messages),
    // …and on disk (what survives a reopen).
    stored: {
      messages: messages.length,
      inContext: inContext.filter(Boolean).length,
      ids: ids.filter(Boolean).length,
    },
    events: listContextEventSummaries(sessionId),
  };
}

/** The session id in a `/verb/<id>` path. */
function idFrom(path: string, prefix: string): string {
  return decodeURIComponent(path.slice(prefix.length));
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
        // ─── Context: what the model can still read ─────────────────────
        if (path.startsWith("/context/") && req.method === "GET") {
          json(res, 200, contextReport(idFrom(path, "/context/")));
          return;
        }
        if (path.startsWith("/context/") && req.method === "POST") {
          const id = idFrom(path, "/context/");
          const b = JSON.parse((await readBody(req)) || "{}") as {
            messageId?: string;
            inContext?: boolean;
          };
          if (!b.messageId) {
            json(res, 400, { error: "messageId is required" });
            return;
          }
          const r = setTurnContext(id, b.messageId, b.inContext !== false);
          json(res, 200, { ...r, context: contextReport(id) });
          return;
        }
        if (path.startsWith("/compact/") && req.method === "POST") {
          const id = idFrom(path, "/compact/");
          const r = await compactSessionNow(id);
          json(res, 200, { compacted: r, context: contextReport(id) });
          return;
        }
        // "Rewind through compact" — the meter's own affordance.
        if (path.startsWith("/uncompact/") && req.method === "POST") {
          const id = idFrom(path, "/uncompact/");
          const b = JSON.parse((await readBody(req)) || "{}") as {
            eventId?: string;
          };
          const eventId =
            b.eventId ??
            listContextEventSummaries(id)
              .filter((e) => e.type === "compact")
              .pop()?.id;
          if (!eventId) {
            json(res, 400, { error: "no compaction to undo" });
            return;
          }
          const r = await undoCompaction(id, eventId);
          json(res, 200, { restored: r, context: contextReport(id) });
          return;
        }

        // The transcript half of "rewind to here" — the renderer pairs this
        // with a checkpoint rewind and drops the prompt in the composer.
        if (path.startsWith("/truncate/") && req.method === "POST") {
          const id = idFrom(path, "/truncate/");
          const b = JSON.parse((await readBody(req)) || "{}") as {
            keepUserTurns?: number;
            totalUserTurns?: number;
          };
          const r = await rewindTranscriptToUserTurn(
            id,
            b.keepUserTurns ?? 0,
            b.totalUserTurns,
          );
          json(res, 200, { ...r, context: contextReport(id) });
          return;
        }

        // ─── Files: the checkpoint side ─────────────────────────────────
        if (path.startsWith("/rewind/") && req.method === "POST") {
          const id = idFrom(path, "/rewind/");
          const b = JSON.parse((await readBody(req)) || "{}") as {
            sha?: string;
          };
          if (!b.sha) {
            json(res, 400, { error: "sha is required" });
            return;
          }
          const [{ rewindWorkspace }, { checkpointFolder }] = await Promise.all([
            import("../agent/checkpoints.js"),
            import("../ipc/chat.js"),
          ]);
          const folder = await checkpointFolder(id);
          json(res, 200, {
            folder,
            ...(await rewindWorkspace(id, folder, b.sha)),
          });
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
