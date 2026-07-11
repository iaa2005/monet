/**
 * Computer Use IPC — read/write the enabled toggle and Denied apps. Changes
 * reset the vendor tool cache so the Code toolset picks up / drops the
 * computer tool immediately.
 */

import { ipcMain } from "electron";
import {
  getComputerConfig,
  setComputerConfig,
  type ComputerConfig,
} from "../computer/config.js";
import { resetVendorTools } from "../agent/vendor-tools.js";

export function registerComputerIPC(): void {
  ipcMain.handle("computer:getConfig", (): ComputerConfig =>
    getComputerConfig(),
  );
  ipcMain.handle(
    "computer:setConfig",
    (_e, patch: Partial<ComputerConfig>): ComputerConfig => {
      const next = setComputerConfig(patch);
      resetVendorTools();
      return next;
    },
  );
}
