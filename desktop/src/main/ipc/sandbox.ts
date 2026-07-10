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

export function registerSandboxIPC(): void {
  ipcMain.handle("sandbox:getConfig", (): SandboxConfig => getSandboxConfig());
  ipcMain.handle(
    "sandbox:setConfig",
    (_e, patch: Partial<SandboxConfig>): SandboxConfig =>
      setSandboxConfig(patch),
  );
}
