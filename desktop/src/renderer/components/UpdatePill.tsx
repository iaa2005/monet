/**
 * "Relaunch to update" — the only surface auto-update has.
 *
 * The update downloaded itself in the background; this pill sits above the
 * account card once it is ready, and clicking it restarts the app into the
 * new version. Dismissable it is not: it takes one row, promises one click,
 * and the same update installs on ordinary quit anyway.
 */

import { useEffect, useState, type JSX } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export function UpdatePill(): JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Ask once (the update may have landed before this window existed),
    // then listen (it may land while we're open).
    void api()
      ?.updates?.pending()
      .then((v) => {
        if (v) setVersion(v);
      })
      .catch(() => {});
    return api()?.updates?.onReady(({ version: v }) => setVersion(v));
  }, []);

  if (!version) return null;

  return (
    <button
      type="button"
      onClick={() => {
        setBusy(true);
        void api()?.updates?.install();
      }}
      className="group mb-1.5 flex w-full items-center gap-3 rounded-[var(--radius)] border border-border bg-popover px-3 py-2.5 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
    >
      <RefreshCw
        className={`size-4 shrink-0 text-brand ${busy ? "animate-spin" : ""}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          Relaunch to update
        </span>
        <span className="block text-xs text-muted-foreground">v{version}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
