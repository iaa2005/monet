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

export function registerSandboxIPC(): void {
  ipcMain.handle("sandbox:getConfig", (): SandboxConfig => getSandboxConfig());
  ipcMain.handle(
    "sandbox:setConfig",
    (_e, patch: Partial<SandboxConfig>): SandboxConfig => {
      const next = setSandboxConfig(patch);
      // The RunPython prompt is engine-specific and cached with the toolset.
      resetVendorTools();
      return next;
    },
  );
}
