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
import { checkPodmanReady } from "../sandbox/podman-engine.js";

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
}
