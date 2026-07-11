/**
 * Automation settings — Browser Use (and, later, Computer Use). These let the
 * Code agent act OUTSIDE the chat (a real browser, the desktop), so they are
 * off by default and gated here.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function Toggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        on ? "bg-emerald-500" : "bg-black/[0.15] dark:bg-white/[0.2]",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-white shadow transition-all",
          on ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

export function AutomationSettings(): JSX.Element {
  const [browserOn, setBrowserOn] = useState(false);

  useEffect(() => {
    api()
      ?.browser.getConfig()
      .then((c) => setBrowserOn(!!c.enabled))
      .catch(() => {});
  }, []);

  const toggleBrowser = (v: boolean): void => {
    setBrowserOn(v);
    void api()?.browser.setConfig({ enabled: v });
  };

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-base font-semibold">Automation</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Let the Code agent act outside the chat. These reach the real world,
          so they are opt-in.
        </p>
      </section>

      {/* Browser Use */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <Globe className="mt-0.5 size-5 shrink-0 text-sky-500" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Browser Use</span>
              <Toggle on={browserOn} onChange={toggleBrowser} />
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">
              The agent can open and drive a separate Chrome/Edge window
              (navigate, read the page, click, type) via the browser tools. It
              uses its OWN profile under the app data folder — your real
              browser and its logins are never touched. The window launches on
              first use.
            </p>
          </div>
        </div>
        {browserOn && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            <span>
              A page the agent visits could contain instructions that try to
              redirect it. Only enable this for tasks you trust, and watch the
              browser window while it works.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
