/**
 * Computer Use IPC — read/write the enabled toggle and Denied apps. Changes
 * reset the vendor tool cache so the Code toolset picks up / drops the
 * computer tool immediately.
 */

import { ipcMain, shell } from "electron";
import {
  getComputerConfig,
  setComputerConfig,
  type ComputerConfig,
} from "../computer/config.js";
import { previewComputerOverlay } from "../computer/overlay.js";
import { resetVendorTools } from "../agent/vendor-tools.js";
import { macHelperBinary, macPermissions } from "../computer/mac.js";

/** What the Settings checklist needs to tell the user what is missing.
 * `supported: false` means this platform grants nothing per-app (Windows), so
 * the UI shows no checklist at all rather than an empty one. */
export interface ComputerPermissions {
  supported: boolean;
  /** Accessibility — synthetic input and the element tree. */
  ax: boolean;
  /** Screen Recording — screenshots and window titles. */
  screen: boolean;
  /** The Swift helper compiled; false means the Xcode Command Line Tools
   * are missing and NOTHING will work until `xcode-select --install`. */
  helper: boolean;
}

// Deep links into the exact panes. Hardcoded here, never built from anything
// a renderer or a model can influence — openExternal takes arbitrary schemes.
const PRIVACY_PANES = {
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;

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
  // Settings → "Preview overlay": show the glow frame + window dodge briefly.
  ipcMain.handle("computer:overlayPreview", async (): Promise<void> => {
    await previewComputerOverlay();
  });

  /**
   * The permission checklist.
   *
   * macOS grants Accessibility and Screen Recording per-app, in System
   * Settings, and NEITHER can be requested from code in a way that just
   * works: the OS shows its prompt once per app and then never again, so an
   * app that misses it has no second chance and no error either — the calls
   * simply return nothing. Every "Computer Use is broken on my Mac" report
   * ends here, which is why this is a visible checklist and not a silent
   * runtime failure.
   */
  ipcMain.handle(
    "computer:permissions",
    async (): Promise<ComputerPermissions> => {
      if (process.platform !== "darwin")
        return { supported: false, ax: true, screen: true, helper: true };
      const helper = (await macHelperBinary()) !== null;
      if (!helper) return { supported: true, ax: false, screen: false, helper: false };
      const p = await macPermissions();
      return { supported: true, ax: p.ax, screen: p.screen, helper: true };
    },
  );

  /** Open the exact Privacy pane. The key picks from a fixed table — the
   * renderer never supplies a URL. */
  ipcMain.handle(
    "computer:openPrivacy",
    async (_e, pane: keyof typeof PRIVACY_PANES): Promise<{ ok: boolean }> => {
      const url = PRIVACY_PANES[pane];
      if (!url) return { ok: false };
      await shell.openExternal(url);
      return { ok: true };
    },
  );
}
