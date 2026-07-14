/**
 * Automation settings — Browser Use (and, later, Computer Use). These let the
 * Code agent act OUTSIDE the chat (a real browser, the desktop), so they are
 * off by default and gated here.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Globe, MonitorSmartphone, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}


export function AutomationSettings(): JSX.Element {
  const [browserOn, setBrowserOn] = useState(false);
  const [computerOn, setComputerOn] = useState(false);
  const [deniedApps, setDeniedApps] = useState<string[]>([]);
  const [newApp, setNewApp] = useState("");

  useEffect(() => {
    api()
      ?.browser.getConfig()
      .then((c) => setBrowserOn(!!c.enabled))
      .catch(() => {});
    api()
      ?.computer.getConfig()
      .then((c) => {
        setComputerOn(!!c.enabled);
        setDeniedApps(c.deniedApps ?? []);
      })
      .catch(() => {});
  }, []);

  const toggleBrowser = (v: boolean): void => {
    setBrowserOn(v);
    void api()?.browser.setConfig({ enabled: v });
  };

  const toggleComputer = (v: boolean): void => {
    setComputerOn(v);
    void api()?.computer.setConfig({ enabled: v });
  };

  const saveDenied = (apps: string[]): void => {
    setDeniedApps(apps);
    void api()?.computer.setConfig({ deniedApps: apps });
  };

  const addDenied = (): void => {
    const a = newApp.trim().toLowerCase().replace(/\.exe$/, "");
    if (a && !deniedApps.includes(a)) saveDenied([...deniedApps, a]);
    setNewApp("");
  };

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-base font-semibold">Automation</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Let the agent act outside the chat — available in both Home and Code.
          These reach the real world, so they are opt-in.
        </p>
      </section>

      {/* Browser Use */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <Globe className="mt-0.5 size-5 shrink-0 text-sky-500" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Browser Use</span>
              <Switch checked={browserOn} onChange={toggleBrowser} />
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

      {/* Computer Use */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <MonitorSmartphone className="mt-0.5 size-5 shrink-0 text-violet-500" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Computer Use</span>
              <Switch checked={computerOn} onChange={toggleComputer} />
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">
              The agent can take screenshots of your screen and control your
              mouse and keyboard. Needs a multimodal model (text + images).
              Some actions can’t be undone; close anything sensitive — the
              agent can see your screen.
            </p>
          </div>
        </div>

        {computerOn && (
          <>
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <span>
                This lets model-generated actions click and type on your real
                desktop. Websites and documents could contain instructions that
                misdirect the agent. Watch it while it works.
              </span>
            </div>

            <div className="mt-4">
              <div className="text-[13px] font-medium">Denied apps</div>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                The agent refuses to act while one of these is the foreground
                window (process name, e.g. <span className="font-mono">1password</span>).
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {deniedApps.map((a) => (
                  <span
                    key={a}
                    className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[12px]"
                  >
                    <span className="font-mono">{a}</span>
                    <button
                      type="button"
                      onClick={() =>
                        saveDenied(deniedApps.filter((x) => x !== a))
                      }
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="mt-2 flex gap-1.5">
                <input
                  value={newApp}
                  onChange={(e) => setNewApp(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addDenied()}
                  placeholder="app process name"
                  className="w-48 rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none focus:border-link"
                />
                <button
                  type="button"
                  onClick={addDenied}
                  className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                >
                  <Plus className="size-3.5" />
                  Add
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
