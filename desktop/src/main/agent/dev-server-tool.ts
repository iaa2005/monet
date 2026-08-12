/**
 * Starting a dev server, as a tool rather than as a shell command.
 *
 * A model with only Bash starts one by running `npm run dev`, which never
 * returns. It works by accident — the shell tool times out, the model sleeps,
 * then guesses the page is up — and it leaves a process nothing owns: not in
 * the panel's list, not stoppable, still holding the port after the chat ends.
 *
 * Through here the app spawns it, so the server appears in the Browser panel
 * beside the ones the user declared, it stops with the app, and starting waits
 * for the port to actually answer instead of being followed by a sleep.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool } from "@vendor/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import {
  findServer,
  mergeDetected,
  readServers,
  serverOutput,
  serverStates,
  startAndWait,
  stopServerAndWait,
  writeServers,
} from "../browser/servers.js";
import { detectDevServers } from "../browser/dev-servers.js";
import { getWorkspacePath } from "../ipc/workspace.js";

interface TextOutput {
  text: string;
  isError: boolean;
}

const mapResult = (
  content: TextOutput,
  toolUseID: string,
): ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: toolUseID,
  content: content.text,
  is_error: content.isError || undefined,
});

const ok = (text: string): { data: TextOutput } => ({
  data: { text, isError: false },
});
const fail = (text: string): { data: TextOutput } => ({
  data: { text, isError: true },
});

const schema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(["list", "start", "stop", "add"])
      .describe("What to do. `list` first if you don't know the names."),
    name: z
      .string()
      .optional()
      .describe("Which server (its name). Required for start/add."),
    command: z
      .string()
      .optional()
      .describe("action=add: the command, e.g. `npm run dev`."),
    port: z
      .number()
      .optional()
      .describe(
        "action=add: the port it will listen on. action=stop: stop whatever serves this port (works for servers started outside this app too).",
      ),
  }),
);
type Schema = ReturnType<typeof schema>;

export const DevServerTool = buildTool({
  name: "DevServer",
  searchHint: "start or stop the project's dev server",
  maxResultSizeChars: 6_000,
  get inputSchema(): Schema {
    return schema();
  },
  userFacingName() {
    return "DevServer";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      "Run the project's dev server. Use this INSTEAD of starting one with the",
      "shell: a dev server never exits, so a shell call either hangs the turn or",
      "leaves a process nobody can stop and nobody can see.",
      "",
      "action=list  — what this project declares, and what is already up.",
      "action=start — start one by name. Waits until the port answers, so you",
      "               can open the page immediately afterwards. No sleeping.",
      "action=stop  — stop by name or by port. Also stops servers started",
      "               outside this app; succeeds only once the port is silent.",
      "action=add   — declare a new one (name, command, port) and start it. The",
      "               entry is saved in the project, so it is there next time.",
      "",
      "If something is already serving the port you want, use it rather than",
      "starting a second copy on another one.",
    ].join("\n");
  },
  async description() {
    return "List, start, stop or declare the project's dev servers.";
  },
  async call({ action, name, command, port }: z.infer<Schema>) {
    const workspace = getWorkspacePath();
    if (!workspace) return fail("No workspace folder is open.");

    try {
      if (action === "list") {
        // Declared AND detected: a server somebody started in a terminal is
        // exactly the one "stop 5173" is usually about.
        const [declared, detected] = await Promise.all([
          serverStates(workspace),
          detectDevServers(workspace),
        ]);
        const states = mergeDetected(declared, detected);
        if (states.length === 0)
          return ok(
            "This project declares no dev servers and nothing is serving on the usual ports. Use action=add with a name, a command and a port.",
          );
        return ok(
          states
            .map(
              (s) =>
                `${s.name} — ${s.status}${
                  s.externallyRunning ? " (started outside this app)" : ""
                }${s.command ? ` · \`${s.command}\`` : ""} on http://localhost:${
                  s.actualPort ?? s.port
                }/${s.error ? `\n  last error: ${s.error}` : ""}`,
            )
            .join("\n"),
        );
      }

      if (action === "add") {
        if (!name || !command || !port)
          return fail("action=add needs name, command and port.");
        if (findServer(workspace, name))
          return fail(`A server called "${name}" already exists — start that one.`);
        const id = `srv-${Date.now().toString(36)}`;
        writeServers(workspace, [
          ...readServers(workspace),
          { id, name, command, port },
        ]);
        const started = await startAndWait(workspace, id);
        return started.ok
          ? ok(
              `Added "${name}" and started it — http://localhost:${started.port ?? port}/` +
                (started.port && started.port !== port
                  ? ` (:${port} was in use, so it took :${started.port}.)`
                  : ""),
            )
          : fail(
              `Added "${name}", but it did not start: ${started.error}\n${serverOutput(id).slice(-1500)}`,
            );
      }

      if (action === "stop") {
        // Resolve generously: a name, a bare port in the name field ("5173"),
        // or the explicit port parameter. The user says "stop 5173" about
        // whatever serves 5173 — declared or not.
        const named = name ? findServer(workspace, name) : null;
        const portArg =
          port ?? (name && /^:?\d{2,5}$/.test(name.trim()) ? Number(name.trim().replace(":", "")) : null);
        const config =
          named ??
          (portArg ? (readServers(workspace).find((s) => s.port === portArg) ?? null) : null);
        const targetPort = config?.port ?? portArg;
        if (!targetPort)
          return fail(
            name
              ? `No server called "${name}". Call action=list, or pass the port.`
              : "action=stop needs a name or a port.",
          );

        const r = await stopServerAndWait(targetPort, config?.id);
        const label = config?.name ?? `:${targetPort}`;
        return r.ok
          ? ok(
              `Stopped ${label} — nothing is listening on :${targetPort} now.` +
                (r.external
                  ? " (It was started outside this app; its process was killed by port.)"
                  : ""),
            )
          : fail(`Could not stop ${label}: ${r.error}`);
      }

      if (!name) return fail(`action=${action} needs a name (see action=list).`);
      const config = findServer(workspace, name);
      if (!config)
        return fail(`No server called "${name}". Call action=list for the names.`);

      const started = await startAndWait(workspace, config.id);
      return started.ok
        ? ok(
            `${config.name} is up — http://localhost:${started.port ?? config.port}/ · BrowserNavigate to open it.` +
              (started.alreadyUp
                ? " (It was already running.)"
                : started.port && started.port !== config.port
                  ? ` (:${config.port} was in use, so it took :${started.port}.)`
                  : ""),
          )
        : fail(
            `${config.name} did not start: ${started.error}\n${serverOutput(config.id).slice(-1500)}`,
          );
    } catch (err) {
      return fail(
        `DevServer failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});
