/**
 * Sandbox IPC — read/write the Home sandbox engine config.
 * (Code execution wiring is added in a later stage.)
 */

import { ipcMain } from "electron";
import {
  getSandboxConfig,
  setSandboxConfig,
  getSessionEngine,
  getSessionEngineOverride,
  setSessionEngine,
  type SandboxConfig,
  type SandboxEngine,
} from "../sandbox/config.js";
import { resetVendorTools } from "../agent/vendor-tools.js";
import { ensurePodmanBinary } from "../sandbox/podman-binary.js";
import {
  checkPodmanReady,
  podmanLikelyReady,
  sandboxWorkDir,
  warmPodman,
} from "../sandbox/podman-engine.js";
import { listSandboxFiles } from "../sandbox/files.js";
import {
  mediaTypeOf,
  runShellInSandbox,
  sandboxSupportsShell,
} from "../sandbox/index.js";

export function registerSandboxIPC(): void {
  ipcMain.handle("sandbox:getConfig", (): SandboxConfig => getSandboxConfig());
  ipcMain.handle(
    "sandbox:setConfig",
    (_e, patch: Partial<SandboxConfig>): SandboxConfig => {
      const next = setSandboxConfig(patch);
      // The RunPython prompt is engine-specific and cached with the toolset.
      resetVendorTools();
      // Switching to Podman: provision the portable CLI in the background so
      // the user installs nothing (the first run won't stall on the download).
      if (next.engine === "docker") void ensurePodmanBinary();
      return next;
    },
  );

  // Explicit "prepare Podman now" for the Settings UI (download + machine
  // start can take a while — the UI can show progress / errors).
  ipcMain.handle(
    "sandbox:preparePodman",
    async (): Promise<{ ok: boolean; error?: string; needsWsl?: boolean }> => {
      const binary = await ensurePodmanBinary();
      if (!binary.ok) return binary;
      const result = await checkPodmanReady();
      resetVendorTools();
      return result;
    },
  );
  ipcMain.handle(
    "sandbox:checkPodman",
    async (): Promise<{ ok: boolean; error?: string; needsWsl?: boolean }> => {
      const result = await checkPodmanReady();
      resetVendorTools();
      return result;
    },
  );

  // Lightweight, non-destructive readiness probe for passive UI (chat banner,
  // send path). Never inits/starts/restarts the machine — unlike checkPodman.
  ipcMain.handle(
    "sandbox:isPodmanReady",
    async (): Promise<{ ok: boolean }> => ({ ok: await podmanLikelyReady() }),
  );

  // Fire-and-forget: start warming the Podman VM in the background (called when
  // a Home chat opens with the Podman engine) so the boot is hidden. Resolves
  // the CHAT's engine (override, else global) so a Podman-pinned chat warms even
  // when the global default is something else.
  ipcMain.handle("sandbox:warmPodman", (_e, sessionId?: string): { ok: true } => {
    const engine = sessionId
      ? getSessionEngine(sessionId)
      : getSandboxConfig().engine;
    if (engine === "docker") warmPodman();
    return { ok: true };
  });

  // The chat's resolved engine + whether it's an explicit override (for the Home
  // engine picker: it shows the effective engine and marks "inherited" vs pinned).
  ipcMain.handle(
    "sandbox:getSessionConfig",
    (
      _e,
      sessionId: string,
    ): { engine: SandboxEngine; override: SandboxEngine | null } => ({
      engine: getSessionEngine(sessionId || "default"),
      override: getSessionEngineOverride(sessionId || "default"),
    }),
  );

  // Pin a chat to an engine (or null to inherit the global default). Refresh the
  // toolset — advertisement + the engine-specific RunPython prompt are cached —
  // and provision Podman when pinning to it so the first run doesn't stall.
  ipcMain.handle(
    "sandbox:setSessionConfig",
    (
      _e,
      sessionId: string,
      engine: SandboxEngine | null,
    ): { engine: SandboxEngine } => {
      const next = setSessionEngine(sessionId || "default", engine);
      resetVendorTools();
      if (next === "docker") {
        void ensurePodmanBinary();
        warmPodman();
      }
      return { engine: next };
    },
  );

  // All files in a chat's sandbox (the /work dir), for the Home Files panel —
  // the full on-disk set, not just files surfaced in the transcript.
  ipcMain.handle("sandbox:listFiles", (_e, sessionId?: string) =>
    listSandboxFiles(sessionId || "default").map((f) => ({
      ...f,
      mediaType: mediaTypeOf(f.name),
    })),
  );

  // Host path of the chat's sandbox working folder (mounted at /work), for the
  // Home Files tree — it's a real directory, so the Code FileTree can browse it.
  ipcMain.handle("sandbox:workDir", (_e, sessionId?: string): string =>
    sandboxWorkDir(sessionId || "default"),
  );

  // A zero-state chat works in the "default" sandbox until its first send
  // creates the session. Whatever landed there belongs to the newborn chat —
  // leaving it under "default" silently donates it to the NEXT zero-state.
  ipcMain.handle(
    "sandbox:adoptDefault",
    async (_e, sessionId: string): Promise<{ moved: number }> => {
      const { readdir, rename } = await import("fs/promises");
      const { join } = await import("path");
      const from = sandboxWorkDir("default");
      const to = sandboxWorkDir(sessionId);
      let moved = 0;
      try {
        for (const name of await readdir(from)) {
          try {
            await rename(join(from, name), join(to, name));
            moved += 1;
          } catch {
            /* locked or colliding file — leave it rather than fail the send */
          }
        }
      } catch {
        /* no default dir yet — nothing to adopt */
      }
      return { moved };
    },
  );

  // Does this chat's engine have a shell? (Home terminal button visibility.)
  ipcMain.handle("sandbox:supportsShell", (_e, sessionId?: string): { ok: boolean } => ({
    ok: sandboxSupportsShell(sessionId || "default"),
  }));

  // Run one command in the chat's sandbox — the Home terminal. Podman/subprocess
  // only; Pyodide returns an error result (guarded in runShellInSandbox).
  ipcMain.handle(
    "sandbox:shellRun",
    (
      _e,
      sessionId: string,
      command: string,
    ): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> =>
      runShellInSandbox(sessionId || "default", command),
  );
}
