/**
 * ACP entry point — `Code Monet --acp`, spawned by an editor.
 *
 * Runs the real Electron main process with no window: the engine needs
 * app.getPath for the data directory, safeStorage for connector secrets, and
 * nativeImage for media, none of which exist under plain Node. What it does
 * NOT do is create a BrowserWindow, so nothing appears on screen.
 *
 * Order matters here. stdout is claimed before anything else is imported,
 * because a single log line from a module's top level would corrupt the
 * JSON-RPC stream before the first message is even sent.
 */

import { app } from "electron";
import { acpStreams, claimStdout } from "./stdio.js";

export async function runAcpMode(): Promise<void> {
  const writeOut = claimStdout();

  // Imported AFTER stdout is claimed — see above.
  const { AgentSideConnection, ndJsonStream } = await import(
    "@agentclientprotocol/sdk"
  );
  const { createAcpAgent } = await import("./agent.js");
  const { runAgent } = await import("../agent/index.js");
  const { applyWorkspaceForRun } = await import("../ipc/workspace.js");

  await app.whenReady();

  const { input, output } = acpStreams(writeOut);
  const stream = ndJsonStream(output, input);

  new AgentSideConnection(
    (conn) =>
      createAcpAgent(conn, {
        runAgent: runAgent as never,
        applyWorkspace: applyWorkspaceForRun,
      }),
    stream,
  );

  // The editor closing its end is the shutdown signal; there is no window to
  // keep the process alive, so hold it open until then.
  await new Promise<void>((resolve) => {
    process.stdin.on("close", resolve);
    process.on("SIGTERM", resolve);
    process.on("SIGINT", resolve);
  });
  app.exit(0);
}

/** Whether this launch is an editor asking for an ACP session. */
export function isAcpLaunch(argv: string[]): boolean {
  return argv.includes("--acp");
}
