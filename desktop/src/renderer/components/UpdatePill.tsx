/**
 * The update, offered — not performed behind the user's back.
 *
 * One row above the account card, and it says what is actually true right
 * now: a version is available (download it?), it is downloading (this far),
 * it is ready (relaunch — or just close the app when you're done and it
 * installs itself), or the download failed and here is why. The old pill only
 * ever appeared after a successful silent download, which is why a release
 * that never managed to download looked exactly like no release at all.
 *
 * Dismissable only in the sense that closing the app finishes the job:
 * autoInstallOnAppQuit is on, so "later" is a real answer.
 */

import { useEffect, useState, type JSX } from "react";
import { ArrowRight, Download, RotateCw, X } from "@/components/icons/hg";
import { useUpdateState } from "@/lib/updates";

const MB = (bytes?: number): string | null =>
  bytes && bytes > 0 ? `${(bytes / (1024 * 1024)).toFixed(0)} MB` : null;

export function UpdatePill(): JSX.Element | null {
  const { state, check, download, install } = useUpdateState();
  // Hidden for this run only. The download is already on disk by then, and
  // the app installs it on quit — so this is "not now", not "never".
  const [hidden, setHidden] = useState(false);

  // A new state is news again: a pill dismissed while it said "failed" must
  // come back when the download it is talking about starts working.
  useEffect(() => setHidden(false), [state.status]);

  if (hidden) return null;
  if (state.status === "idle" || state.status === "checking") return null;

  const row =
    "group mb-1.5 flex w-full items-center gap-3 rounded-[var(--radius)] border border-border bg-popover px-3 py-2.5 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]";

  if (state.status === "downloading")
    return (
      <div className="mb-1.5 w-full rounded-[var(--radius)] border border-border bg-popover px-3 py-2.5">
        <div className="flex items-center gap-3">
          <Download className="size-4 shrink-0 text-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            Downloading v{state.version}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {state.percent}%
          </span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-300"
            style={{ width: `${state.percent}%` }}
          />
        </div>
      </div>
    );

  if (state.status === "ready")
    return (
      <button type="button" onClick={install} className={row}>
        <RotateCw className="size-4 shrink-0 text-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            Relaunch to update
          </span>
          <span className="block text-xs text-muted-foreground">
            v{state.version} — or on your next quit
          </span>
        </span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </button>
    );

  if (state.status === "error")
    return (
      <div className="mb-1.5 w-full rounded-[var(--radius)] border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Update failed</span>
            <span className="block break-words text-xs text-muted-foreground">
              {state.message}
            </span>
          </span>
          <button
            type="button"
            onClick={() => setHidden(true)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => (state.version ? download() : void check())}
          className="mt-2 flex items-center gap-1.5 text-xs font-medium text-foreground hover:underline"
        >
          <RotateCw className="size-3.5" />
          Try again
        </button>
      </div>
    );

  // available — the offer itself. Nothing has been downloaded yet.
  const size = MB(state.bytes);
  return (
    <button
      type="button"
      onClick={download}
      className={row}
    >
      <Download className="size-4 shrink-0 text-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          Download update
        </span>
        <span className="block text-xs text-muted-foreground">
          v{state.version}
          {size ? ` — ${size}` : ""}
        </span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
