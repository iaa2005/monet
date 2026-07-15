/**
 * Sandbox IPC — read/write the Home sandbox engine config.
 * (Code execution wiring is added in a later stage.)
 */

import { ipcMain } from "electron";
import {
  getSandboxConfig,
  setSandboxConfig,
  type SandboxConfig,
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
import { mediaTypeOf } from "../sandbox/index.js";

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
  // a Home chat opens with the Podman engine) so the boot is hidden.
  ipcMain.handle("sandbox:warmPodman", (): { ok: true } => {
    if (getSandboxConfig().engine === "docker") warmPodman();
    return { ok: true };
  });

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
}
