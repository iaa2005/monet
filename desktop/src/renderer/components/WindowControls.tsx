import { useState, useEffect } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** Custom min / maximize-restore / close buttons for the frameless window.
 *
 * Rendered as a FIXED layer above everything (modals sit at z-50/60): the
 * window must stay minimizable/closable even mid-dialog — otherwise an open
 * modal takes the whole window hostage. An in-flow spacer keeps the header
 * layout exactly where it was. */
export function WindowControls(): JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    api()?.win.isMaximized().then(setMaximized).catch(() => {});
    return api()?.win.onMaximizeChange(setMaximized);
  }, []);

  // 46px is the Windows caption-button width; the HEIGHT comes from the title
  // bar's own token, so a hover block can never overhang the bar again.
  const base =
    "app-no-drag flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors";

  return (
    <>
      {/* Spacer holds the header slot the fixed buttons visually occupy. */}
      <div aria-hidden className="h-full w-[138px] shrink-0" />
      <div className="app-no-drag fixed right-0 top-0 z-[200] flex h-[var(--titlebar-h)] items-stretch">
      <button
        type="button"
        title="Minimize"
        aria-label="Minimize"
        onClick={() => api()?.win.minimize()}
        className={`${base} hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]`}
      >
        <Minus className="size-4" />
      </button>
      <button
        type="button"
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => api()?.win.toggleMaximize()}
        className={`${base} hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]`}
      >
        {maximized ? (
          <Copy className="size-3.5 -scale-x-100" />
        ) : (
          <Square className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        title="Close"
        aria-label="Close"
        onClick={() => api()?.win.close()}
        className={`${base} hover:bg-red-500 hover:text-white`}
      >
        <X className="size-4" />
      </button>
      </div>
    </>
  );
}
