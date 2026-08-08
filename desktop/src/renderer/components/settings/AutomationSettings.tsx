/**
 * Automation settings — Browser Use (and, later, Computer Use). These let the
 * Code agent act OUTSIDE the chat (a real browser, the desktop), so they are
 * off by default and gated here.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Globe, MonitorSmartphone, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import type {
  BrowserApproval,
  BrowserEngine,
  ElectronAPI,
} from "@/types/electron";
import { isValidPattern } from "@shared/origins";
import { SectionTitle } from "@/components/settings/SectionTitle";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}


export function AutomationSettings(): JSX.Element {
  const [browserOn, setBrowserOn] = useState(false);
  const [engine, setEngine] = useState<BrowserEngine>("embedded");
  const [approval, setApproval] = useState<BrowserApproval>("allowlist");
  const [allowedOrigins, setAllowedOrigins] = useState<string[]>([]);
  const [newOrigin, setNewOrigin] = useState("");
  const [originError, setOriginError] = useState<string | null>(null);
  const [computerOn, setComputerOn] = useState(false);
  const [deniedApps, setDeniedApps] = useState<string[]>([]);
  const [newApp, setNewApp] = useState("");

  useEffect(() => {
    api()
      ?.browser.getConfig()
      .then((c) => {
        setBrowserOn(!!c.enabled);
        setEngine(c.engine);
        setApproval(c.approval);
        setAllowedOrigins(c.allowedOrigins);
      })
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

  const changeEngine = (v: BrowserEngine): void => {
    setEngine(v);
    void api()?.browser.setConfig({ engine: v });
  };

  const changeApproval = (v: BrowserApproval): void => {
    setApproval(v);
    void api()?.browser.setConfig({ approval: v });
  };

  const saveOrigins = (list: string[]): void => {
    setAllowedOrigins(list);
    void api()?.browser.setConfig({ allowedOrigins: list });
  };

  const addOrigin = (): void => {
    const o = newOrigin.trim().replace(/\/+$/, "");
    if (!o) return;
    // Validated here rather than on save: a bare hostname looks right and
    // silently matches nothing, which reads as the allowlist being ignored.
    if (!isValidPattern(o)) {
      setOriginError(
        "Needs a scheme and a host, e.g. https://example.com — not a path or a bare name.",
      );
      return;
    }
    if (!allowedOrigins.includes(o)) saveOrigins([...allowedOrigins, o]);
    setNewOrigin("");
    setOriginError(null);
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
        <SectionTitle>Automation</SectionTitle>
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
              <span className="text-sm font-medium">Browser tools</span>
              <Switch checked={browserOn} onChange={toggleBrowser} />
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">
              The agent can open pages, read them, click and type. The Browser
              panel itself is always available — this switch is about whether
              the AGENT gets the tools for it.
            </p>
          </div>
        </div>

        {browserOn && (
          <div className="mt-4">
            <div className="text-[13px] font-medium">Which browser</div>
            <div className="mt-2 space-y-1.5">
              {(
                [
                  [
                    "embedded",
                    "The Browser panel",
                    "The tabs beside your chat. You watch what it does, and design mode works here.",
                  ],
                  [
                    "external",
                    "A separate Chrome window",
                    "Its own profile under the app data folder — your real browser is never touched. For sites that refuse an embedded view, or when you need extensions.",
                  ],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => changeEngine(value)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                    engine === value
                      ? "border-link bg-link/[0.06]"
                      : "border-border hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
                  )}
                >
                  <span
                    className={cn(
                      "mt-1 size-2 shrink-0 rounded-full",
                      engine === value ? "bg-link" : "bg-border",
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{label}</span>
                    <span className="block text-[12px] text-muted-foreground">
                      {hint}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {browserOn && (
          <div className="mt-4">
            <div className="text-[13px] font-medium">Ask before acting</div>
            <div className="mt-2 space-y-1.5">
              {(
                [
                  [
                    "allowlist",
                    "Allowed sites run silently",
                    "localhost is always allowed. Anywhere else asks, unless you add it below.",
                  ],
                  [
                    "manual",
                    "Ask about everything",
                    "Every navigation and click waits for you, including on localhost.",
                  ],
                  [
                    "auto",
                    "Never ask",
                    "Fast, and unsafe on a site you don't control: a page can carry instructions aimed at the agent.",
                  ],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => changeApproval(value)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                    approval === value
                      ? "border-link bg-link/[0.06]"
                      : "border-border hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
                  )}
                >
                  <span
                    className={cn(
                      "mt-1 size-2 shrink-0 rounded-full",
                      approval === value ? "bg-link" : "bg-border",
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{label}</span>
                    <span className="block text-[12px] text-muted-foreground">
                      {hint}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            {approval === "allowlist" && (
              <div className="mt-3">
                <div className="text-[13px] font-medium">Allowed sites</div>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  Origins, not pages:{" "}
                  <span className="font-mono">https://acme.dev</span>,{" "}
                  <span className="font-mono">https://*.acme.dev</span>,{" "}
                  <span className="font-mono">http://build.local:8080</span>. A
                  port matters — add <span className="font-mono">:*</span> for any.
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {allowedOrigins.map((o) => (
                    <span
                      key={o}
                      className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[12px]"
                    >
                      <span className="font-mono">{o}</span>
                      <button
                        type="button"
                        onClick={() =>
                          saveOrigins(allowedOrigins.filter((x) => x !== o))
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
                    value={newOrigin}
                    onChange={(e) => {
                      setNewOrigin(e.target.value);
                      setOriginError(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && addOrigin()}
                    placeholder="https://example.com"
                    spellCheck={false}
                    className="w-64 rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px] outline-none focus:border-link"
                  />
                  <button
                    type="button"
                    onClick={addOrigin}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                  >
                    <Plus className="size-3.5" />
                    Add
                  </button>
                </div>
                {originError && (
                  <p className="mt-1 text-[12px] text-destructive">{originError}</p>
                )}
              </div>
            )}
          </div>
        )}

        {browserOn && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            <span>
              A page the agent visits could contain instructions that try to
              redirect it. Only enable this for tasks you trust, and watch the
              panel while it works.
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
