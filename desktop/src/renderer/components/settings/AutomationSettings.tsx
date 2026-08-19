/**
 * Automation settings — Browser Use (and, later, Computer Use). These let the
 * Code agent act OUTSIDE the chat (a real browser, the desktop), so they are
 * off by default and gated here.
 */

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Chrome,
  Copy,
  Download,
  Eye,
  ListChecks,
  PanelRight,
  Plus,
  Puzzle,
  RefreshCw,
  ShieldQuestion,
  X,
  Zap,
} from "@/components/icons/hg";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import type {
  BrowserApproval,
  BrowserEngine,
  ComputerPermissions,
  ElectronAPI,
} from "@/types/electron";
import { isValidPattern } from "@shared/origins";
import {
  SectionHeader,
  SectionTitle,
} from "@/components/settings/SectionTitle";
import { PickCard } from "@/components/settings/PickCard";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function isMacUi(): boolean {
  return api()?.platform === "darwin";
}

/**
 * Pairing the user's own browser: get the extension, carry the code across.
 *
 * The code is the whole access control. A local WebSocket that can drive a
 * signed-in browser must not answer to anyone who finds the port — a page you
 * visit can open a WebSocket to localhost, and CORS does not stop it. So the
 * app refuses every connection that cannot produce this, and the only way it
 * travels is a person typing it into the extension.
 */
/**
 * The macOS permission checklist for Computer Use.
 *
 * macOS grants Accessibility and Screen Recording per app, and its prompt
 * appears once — miss it and every call afterwards just returns nothing, with
 * no error to read. So the state is shown rather than assumed, with the
 * button that opens the exact pane, and it re-checks itself while the section
 * is open: the grant lands in another app, and coming back to a stale "not
 * granted" is how people conclude the feature is broken.
 */
function MacPermissionChecklist(): JSX.Element {
  const [perms, setPerms] = useState<ComputerPermissions | null>(null);

  useEffect(() => {
    let live = true;
    const poll = (): void => {
      api()
        ?.computer.permissions?.()
        .then((p) => live && setPerms(p))
        .catch(() => {});
    };
    poll();
    // Granting happens in System Settings, so the answer changes while this
    // panel is in the background — poll instead of waiting for a remount.
    const t = setInterval(poll, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (!perms?.supported) return <></>;

  if (!perms.helper) {
    return (
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px]">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        <span>
          Computer Use needs the Xcode Command Line Tools to build its helper.
          Run <span className="font-mono">xcode-select --install</span> in a
          terminal, then reopen this panel.
        </span>
      </div>
    );
  }

  const rows: {
    key: "accessibility" | "screen";
    ok: boolean;
    label: string;
    why: string;
  }[] = [
    {
      key: "accessibility",
      ok: perms.ax,
      label: "Accessibility",
      why: "Move the mouse, type, and read on-screen controls.",
    },
    {
      key: "screen",
      ok: perms.screen,
      label: "Screen Recording",
      why: "Take screenshots and read window titles.",
    },
  ];
  const allOk = rows.every((r) => r.ok);

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[13px] font-medium">
        <ShieldQuestion className="size-3.5 text-muted-foreground" />
        System permissions
        {allOk && (
          <span className="ml-1 inline-flex items-center gap-1 text-[11px] font-normal text-emerald-600 dark:text-emerald-400">
            <Check className="size-3" />
            all set
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        Granted per app in System Settings → Privacy &amp; Security. macOS asks
        once, so grant them here if you missed the prompt. After granting,
        quit and reopen the app.
      </p>
      <div className="mt-2 space-y-1.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2">
            {r.ok ? (
              <Check className="size-3.5 shrink-0 text-emerald-500" />
            ) : (
              <X className="size-3.5 shrink-0 text-destructive" />
            )}
            <span className="text-[12px] font-medium">{r.label}</span>
            <span className="flex-1 truncate text-[12px] text-muted-foreground">
              {r.why}
            </span>
            {!r.ok && (
              <button
                type="button"
                onClick={() => void api()?.computer.openPrivacy?.(r.key)}
                className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11px] font-medium hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              >
                Open Settings
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function BridgePairing(): JSX.Element {
  const [status, setStatus] = useState<{
    connected: boolean;
    token: string;
    tabs: { id: number; url: string; title: string; session: string | null }[];
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const poll = (): void => {
      api()
        ?.browser.bridgeStatus()
        .then((s) => live && setStatus(s))
        .catch(() => {});
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const download = async (): Promise<void> => {
    const r = await api()?.browser.bridgeExport();
    if (r?.ok && r.path) setSaved(r.path);
  };

  const copy = (): void => {
    if (!status?.token) return;
    void navigator.clipboard.writeText(status.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mt-4 rounded-lg border border-border/60 p-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-2 rounded-full",
            status?.connected ? "bg-emerald-500" : "bg-muted-foreground/40",
          )}
        />
        <span className="text-[13px] font-medium">
          {status?.connected ? "Your browser is paired" : "No browser paired yet"}
        </span>
      </div>
      {status?.connected && (
        <div className="mt-1 text-[12px] text-muted-foreground">
          {status.tabs.length > 0
            ? `${status.tabs.length} tab(s) open in ${
                new Set(status.tabs.map((t) => t.session)).size
              } session(s) — look for the “agent:…” groups in your browser.`
            : "No tabs yet. The agent opens its own when it needs one; they go into a tab group named after the chat."}
        </div>
      )}

      <ol className="mt-3 space-y-2.5 text-[12px] text-muted-foreground">
        <li>
          <span className="text-foreground">1. Get the extension.</span> It is
          saved as a folder — that is what Chrome's “Load unpacked” asks for.
          <div className="mt-1.5">
            <button
              type="button"
              onClick={() => void download()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-[12px] text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            >
              <Download className="size-3.5" />
              Download extension
            </button>
            {saved && (
              <div className="mt-1 break-all text-[11px]">Saved to {saved}</div>
            )}
          </div>
        </li>
        <li>
          <span className="text-foreground">2. Load it.</span> Open{" "}
          <code className="rounded bg-black/[0.06] px-1 dark:bg-white/[0.08]">
            chrome://extensions
          </code>
          , turn on Developer mode, click “Load unpacked”, pick that folder.
        </li>
        <li>
          <span className="text-foreground">3. Pair it.</span> Click the
          extension, paste this code:
          <div className="mt-1.5 flex items-center gap-1.5">
            <code className="rounded bg-black/[0.06] px-2 py-1 font-mono text-[13px] tracking-widest text-foreground dark:bg-white/[0.08]">
              {status?.token ?? "…"}
            </code>
            <button
              type="button"
              onClick={copy}
              title="Copy"
              className="rounded-md border border-border/60 p-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-500" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => void api()?.browser.bridgeRegenerate()}
              title="New code — unpairs every browser"
              className="rounded-md border border-border/60 p-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
        </li>
        <li>
          <span className="text-foreground">4. That is all.</span> The agent
          opens its own tabs when it needs them, in a group named{" "}
          <code className="rounded bg-black/[0.06] px-1 dark:bg-white/[0.08]">
            agent:…
          </code>{" "}
          after the chat — close the group to end the excursion. It cannot touch
          any other tab: a command naming one is refused in the browser, not
          just discouraged. To lend it a page you are on, press Attach in the
          extension.
        </li>
      </ol>
    </div>
  );
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
    <div className="divide-y divide-border">
      <section className="pb-5">
        <SectionHeader
        title="Automation"
        description="Let the agent act outside the chat — available in both Home and Code. These reach the real world, so they are opt-in."
      />
      </section>

      {/* Browser Use */}
      <section className="py-5">
        <SectionHeader
          title="Browser tools"
          description="The agent can open pages, read them, click and type. The Browser panel itself is always available — this switch is about whether the AGENT gets the tools for it."
          control={<Switch checked={browserOn} onChange={toggleBrowser} />}
        />

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
                    PanelRight,
                  ],
                  [
                    "external",
                    "A separate Chrome window",
                    "Its own profile under the app data folder — your real browser is never touched. For sites that refuse an embedded view, or when you need extensions.",
                    Chrome,
                  ],
                  [
                    "bridge",
                    "Your own browser, through the extension",
                    "The browser you already use, already signed in — nothing has to be signed into twice. It only ever touches the one tab you hand it.",
                    Puzzle,
                  ],
                ] as const
              ).map(([value, label, hint, icon]) => (
                <PickCard
                  key={value}
                  icon={icon}
                  title={label}
                  description={hint}
                  selected={engine === value}
                  onClick={() => changeEngine(value)}
                />
              ))}
            </div>
          </div>
        )}

        {browserOn && engine === "bridge" && <BridgePairing />}

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
                    ListChecks,
                  ],
                  [
                    "manual",
                    "Ask about everything",
                    "Every navigation and click waits for you, including on localhost.",
                    ShieldQuestion,
                  ],
                  [
                    "auto",
                    "Never ask",
                    "Fast, and unsafe on a site you don't control: a page can carry instructions aimed at the agent.",
                    Zap,
                  ],
                ] as const
              ).map(([value, label, hint, icon]) => (
                <PickCard
                  key={value}
                  icon={icon}
                  title={label}
                  description={hint}
                  selected={approval === value}
                  onClick={() => changeApproval(value)}
                />
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
      </section>

      {/* Computer Use */}
      <section className="pt-5">
        <SectionHeader
          title="Computer use"
          description="The agent can take screenshots of your screen and control your mouse and keyboard. A multimodal model works from screenshots; a text-only model drives through the system accessibility tree. Some actions cannot be undone; close anything sensitive — the agent can see your screen."
          control={<Switch checked={computerOn} onChange={toggleComputer} />}
        />
        {computerOn && (
          <>
            <MacPermissionChecklist />
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <span>
                This lets model-generated actions click and type on your real
                desktop. Websites and documents could contain instructions that
                misdirect the agent. Watch it while it works.
              </span>
            </div>

            <p className="mt-3 text-[12px] text-muted-foreground">
              {isMacUi()
                ? "While the agent drives, a glowing frame marks the screen. This window stays where you put it — it is excluded from screenshots, and clicks pass straight through the frame to whatever is underneath."
                : "While the agent drives, a glowing frame marks the screen and this window steps into the top-right corner. The frame never appears in screenshots — not even the agent's own."}
            </p>

            {/* Dev only: firing the overlay by hand is for working ON it. */}
            {import.meta.env.DEV && (
              <button
                type="button"
                onClick={() => void api()?.computer.overlayPreview()}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-[12px] text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              >
                <Eye className="size-3.5" />
                Preview overlay
              </button>
            )}

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
      </section>
    </div>
  );
}
