/**
 * Sandbox IPC — read/write the Home sandbox engine config.
 * (Code execution wiring is added in a later stage.)
 */

import { BrowserWindow, ipcMain } from "electron";
import {
  closeTerminal,
  hasTerminal,
  onTerminalData,
  onTerminalExit,
  openTerminal,
  resizeTerminal,
  writeTerminal,
} from "../terminal/sessions.js";
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
  ensureSandboxImage,
  podmanLikelyReady,
  resetImageCache,
  sandboxWorkDir,
  warmPodman,
} from "../sandbox/podman-engine.js";
import {
  IMAGE_PRESETS,
  getImageExtras,
  setImageExtras,
  imageTagFor,
  type ImageExtras,
  type ImagePreset,
} from "../sandbox/image-extras.js";
import { listSandboxFiles, readSandboxFile } from "../sandbox/files.js";
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

  // ── The image the sandbox runs, and what the user added to it ────────
  //
  // A chat cannot install a toolchain for itself: the container is --rm, so
  // apt's work dies with it. These write the recipe for a LAYER on top of the
  // base image; the build happens on rebuild (or lazily, on the next run).

  ipcMain.handle(
    "sandboxImage:get",
    (): { extras: ImageExtras; presets: ImagePreset[]; tag: string } => ({
      extras: getImageExtras(),
      presets: IMAGE_PRESETS,
      tag: imageTagFor(),
    }),
  );

  ipcMain.handle(
    "sandboxImage:set",
    (_e, patch: Partial<ImageExtras>): { extras: ImageExtras; tag: string } => {
      const extras = setImageExtras(patch);
      // Without this the process would keep running whatever image it built
      // first, and a newly ticked toolchain would not appear until a restart.
      resetImageCache();
      return { extras, tag: imageTagFor(extras) };
    },
  );

  /**
   * Build the layer now, rather than on the next run.
   *
   * Minutes, so the UI wants to drive it explicitly and show the log. Failure
   * here is NOT a broken sandbox — ensureSandboxImage falls back to the base
   * and says so in its log, which is what gets returned.
   */
  ipcMain.handle(
    "sandboxImage:rebuild",
    async (): Promise<{ ok: boolean; log: string; error?: string; tag: string }> => {
      resetImageCache();
      const r = await ensureSandboxImage();
      return { ...r, tag: imageTagFor() };
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

  // One text file out of the sandbox, for the renderer.
  //
  // The chart widget's `src` reads its rows through here. artifacts:readText
  // could not: it resolves under the ARTIFACTS directory and a sandbox file is
  // not there, so every src-backed chart failed with "outside artifacts dir".
  // readSandboxFile does the containment itself — no absolute paths, no "..",
  // 400 KB cap — which is the same guard the Read tool runs behind.
  ipcMain.handle(
    "sandbox:readText",
    (_e, sessionId: string | undefined, name: string) =>
      readSandboxFile(sessionId || "default", name),
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

  // Run one command in the chat's sandbox. Kept for callers that want a single
  // command and its result — the TERMINAL no longer goes through here; it holds
  // a live pty (see terminal/sessions.ts).
  ipcMain.handle(
    "sandbox:shellRun",
    (
      _e,
      sessionId: string,
      command: string,
    ): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> =>
      runShellInSandbox(sessionId || "default", command),
  );

  // ── The terminal: one live shell per chat ────────────────────────────

  ipcMain.handle(
    "terminal:open",
    (
      _e,
      sessionId: string,
      space: string | undefined,
      cols?: number,
      rows?: number,
    ): Promise<{ ok: boolean; buffer?: string; error?: string }> =>
      openTerminal(sessionId || "default", space, cols, rows),
  );

  ipcMain.on("terminal:write", (_e, sessionId: string, data: string): void => {
    // `on`, not `handle`: keystrokes are a stream, and a round trip per
    // character would put the renderer's event loop in the middle of typing.
    writeTerminal(sessionId || "default", data);
  });

  ipcMain.on(
    "terminal:resize",
    (_e, sessionId: string, cols: number, rows: number): void => {
      resizeTerminal(sessionId || "default", cols, rows);
    },
  );

  ipcMain.handle("terminal:close", (_e, sessionId: string): void => {
    closeTerminal(sessionId || "default");
  });

  ipcMain.handle("terminal:has", (_e, sessionId: string): { ok: boolean } => ({
    ok: hasTerminal(sessionId || "default"),
  }));

  // Output goes to every window: there is one, and a session is not owned by
  // a particular renderer — the panel can be closed and reopened while the
  // shell carries on.
  onTerminalData((sessionId, data) => {
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send("terminal:data", sessionId, data);
  });
  onTerminalExit((sessionId, code) => {
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send("terminal:exit", sessionId, code);
  });
}
