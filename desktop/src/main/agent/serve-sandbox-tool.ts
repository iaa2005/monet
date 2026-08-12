/**
 * ServeSandbox — Home's way to show a page in the browser.
 *
 * Home writes files into the chat's sandbox; this serves that folder over
 * HTTP from inside the sandbox container, on a loopback-only port (see
 * sandbox/podman-server.ts for the isolation argument). The model gets a URL
 * it can hand to BrowserNavigate, and the user gets a page that came out of
 * the sandbox rather than out of their home directory.
 *
 * Why Home does not simply use DevServer: that tool runs a command on the
 * HOST, in the Code workspace. In Home there is no workspace, so it used to
 * serve the app's own project root — the failure this tool exists to end.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "../engine/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import {
  getSandboxServer,
  sandboxServerLogs,
  startSandboxServer,
  stopSandboxServer,
} from "../sandbox/podman-server.js";
import { getSessionEngine } from "../sandbox/config.js";
import { tunablePrompt } from "../prompts/index.js";

interface Output {
  text: string;
  isError: boolean;
}

const out = (text: string, isError = false): { data: Output } => ({
  data: { text, isError },
});

const schema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(["start", "stop", "status", "logs"])
      .describe("What to do. `start` is idempotent — it returns the running server."),
    command: z
      .string()
      .optional()
      .describe(
        "Custom server command run INSIDE the sandbox, e.g. `npm run dev -- --host 0.0.0.0 --port 8000`. Omit for a static file server over the chat's folder. It must listen on 0.0.0.0 and on `port`, or nothing can reach it.",
      ),
    port: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .optional()
      .describe("Port the command listens on inside the sandbox. Default 8000."),
  }),
);

type Schema = ReturnType<typeof schema>;

export const ServeSandboxTool = buildTool({
  name: "ServeSandbox",
  get inputSchema(): Schema {
    return schema();
  },
  searchHint: "serve the chat's sandbox folder over http so a page can be viewed",
  maxResultSizeChars: 4_000,
  userFacingName() {
    return "Serve sandbox";
  },
  isReadOnly() {
    return false; // starts a container
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return tunablePrompt(
      "tool-serve-sandbox",
      [
        "Serve this chat's sandbox folder over HTTP so a page you wrote can be",
        "opened in the browser. The document root is the sandbox itself — the",
        "same folder SandboxWrite and RunPython use — so write your .html",
        "there and it is served immediately; never copy files anywhere else to",
        "make them reachable.",
        "",
        "The URL is loopback-only and the server runs inside the isolated",
        "sandbox container, so it needs the Podman engine. With Pyodide or the",
        "subprocess engine the tool refuses and tells the user what to switch.",
        "",
        "After `start`, open the returned URL with BrowserNavigate — append the",
        "file name (…/page.html) unless the folder has an index.html. Use",
        "`logs` when a page does not load, and `stop` when you are done.",
        "For a framework dev server pass `command`; it must bind 0.0.0.0.",
      ].join("\n"),
    );
  },
  async description() {
    return "Serve the chat's sandbox folder over a local-only HTTP URL (Podman sandbox).";
  },
  async call(input: z.infer<Schema>, context: ToolUseContext) {
    const sessionId = (context as { sessionId?: string }).sessionId || "default";

    if (input.action === "status") {
      const server = getSandboxServer(sessionId);
      return out(
        server
          ? `Serving ${server.url} (command: ${server.command})`
          : "No server is running for this chat.",
      );
    }
    if (input.action === "logs") {
      const log = await sandboxServerLogs(sessionId);
      return out(log.trim() || "No output from the server yet.");
    }
    if (input.action === "stop") {
      const stopped = await stopSandboxServer(sessionId);
      return out(stopped ? "Server stopped." : "No server was running.");
    }

    // start — the engine gate is the whole point, so it is checked here and
    // explained in terms the user can act on.
    if (getSessionEngine(sessionId) !== "docker") {
      return out(
        [
          "This chat's sandbox engine cannot serve a page.",
          "",
          "Pyodide runs Python in WebAssembly and has no sockets; the",
          "subprocess engine runs on the user's own machine, so serving from it",
          "would expose their files — Home does not do that.",
          "",
          "Tell the user to switch this chat's sandbox engine to Podman (the",
          "engine menu in the app's top bar, next to Files), then call",
          "ServeSandbox again. Meanwhile the .html file you wrote is still",
          "attached to the chat and they can open it from there.",
        ].join("\n"),
        true,
      );
    }

    const r = await startSandboxServer(sessionId, {
      command: input.command,
      containerPort: input.port,
    });
    if (!r.ok || !r.server)
      return out(
        [`Could not start the server: ${r.error}`, r.log ? `\nLog:\n${r.log}` : ""]
          .filter(Boolean)
          .join(""),
        true,
      );
    return out(
      [
        `Serving the sandbox at ${r.server.url}`,
        `Command: ${r.server.command}`,
        "",
        "Open it with BrowserNavigate — add the file name if there is no index.html.",
        "The URL answers on this machine only.",
      ].join("\n"),
    );
  },
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      type: "tool_result",
      tool_use_id: toolUseID,
      content: content.text,
      is_error: content.isError || undefined,
    };
  },
  renderToolUseMessage() {
    return null;
  },
});
