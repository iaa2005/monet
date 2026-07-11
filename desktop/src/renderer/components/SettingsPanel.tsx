import { useState, useEffect } from "react";
import {
  Settings2,
  Boxes,
  Info,
  Check,
  FolderOpen,
  BookMarked,
  Plug,
  Search,
  FlaskConical,
  AlertTriangle,
  MousePointerClick,
} from "lucide-react";
import { ProviderSettings } from "@/components/providers/ProviderSettings";
import { SkillsSettings } from "@/components/settings/SkillsSettings";
import { ConnectorsSettings } from "@/components/settings/ConnectorsSettings";
import { AutomationSettings } from "@/components/settings/AutomationSettings";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function StorageSection(): JSX.Element {
  const [dir, setDir] = useState<string>("");
  const [isDefault, setIsDefault] = useState(true);

  const load = (): void => {
    api()
      ?.settings.getDataDir()
      .then((r) => {
        setDir(r.dir);
        setIsDefault(r.isDefault);
      })
      .catch(() => {});
  };
  useEffect(load, []);

  const change = async (): Promise<void> => {
    const picked = await api()?.settings.pickDataDir();
    if (picked) load();
  };

  return (
    <section>
      <h3 className="text-base font-semibold">Data folder</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Where chats, sessions and settings are stored. Changing it takes effect
        after a restart.
      </p>
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-2">
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={dir}>
          {dir || "…"}
        </span>
        {isDefault && (
          <span className="shrink-0 rounded bg-black/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground dark:bg-white/[0.08]">
            default
          </span>
        )}
        <button
          type="button"
          onClick={change}
          className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
        >
          Change…
        </button>
      </div>
    </section>
  );
}

type Section =
  | "general"
  | "providers"
  | "sandbox"
  | "automation"
  | "skills"
  | "connectors"
  | "about";

const NAV: {
  group: string;
  items: { id: Section; label: string; icon: typeof Settings2 }[];
}[] = [
  {
    group: "Settings",
    items: [
      { id: "general", label: "General", icon: Settings2 },
      { id: "providers", label: "Providers", icon: Boxes },
      { id: "sandbox", label: "Sandbox", icon: FlaskConical },
      { id: "automation", label: "Automation", icon: MousePointerClick },
    ],
  },
  {
    group: "Customize",
    items: [
      { id: "skills", label: "Skills", icon: BookMarked },
      { id: "connectors", label: "Connectors", icon: Plug },
    ],
  },
  { group: "About", items: [{ id: "about", label: "About", icon: Info }] },
];

const SANDBOX_ENGINES: {
  id: string;
  title: string;
  blurb: string;
  warn?: boolean;
  disabled?: boolean;
}[] = [
  {
    id: "pyodide",
    title: "Pyodide (Python in WebAssembly)",
    blurb:
      "Default. Python and JavaScript run inside the app, fully isolated — no access to your files or network. Great for documents, tables and charts (pandas, matplotlib, python-docx, openpyxl).",
  },
  {
    id: "subprocess",
    title: "Local subprocess (real Python / Node)",
    blurb:
      "Runs real python/node in a per-chat temp folder. Full power, but code executes on your machine WITHOUT hard isolation — use only with models you trust.",
    warn: true,
  },
  {
    id: "docker",
    title: "Podman container",
    blurb:
      "Real Python + Node + LaTeX (tectonic) in an isolated container. Requires Podman (on Windows: podman machine init && start). The shared image builds once on first use (~400MB); chats add only copy-on-write layers, not gigabytes.",
  },
];

function SandboxSection(): JSX.Element {
  const [engine, setEngine] = useState<string>("pyodide");

  useEffect(() => {
    api()
      ?.sandbox.getConfig()
      .then((c) => setEngine(c.engine))
      .catch(() => {});
  }, []);

  const choose = (id: string): void => {
    setEngine(id);
    void api()?.sandbox.setConfig({ engine: id });
  };

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-base font-semibold">Sandbox</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Where Home runs generated code (Python and scripts for documents,
          tables and charts). Home is isolated from your project — Code mode
          works directly with your files instead.
        </p>
      </section>

      <div className="space-y-2">
        {SANDBOX_ENGINES.map((e) => {
          const active = engine === e.id;
          return (
            <button
              key={e.id}
              type="button"
              disabled={e.disabled}
              onClick={() => !e.disabled && choose(e.id)}
              className={cn(
                "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                active
                  ? "border-foreground/40 ring-1 ring-foreground/20"
                  : "border-border hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
                e.disabled && "cursor-not-allowed opacity-55 hover:bg-transparent",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                  active
                    ? "border-transparent bg-foreground text-background"
                    : "border-border",
                )}
              >
                {active && <Check className="size-3" />}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {e.title}
                  {e.warn && (
                    <AlertTriangle className="size-3.5 text-amber-500" />
                  )}
                  {e.disabled && (
                    <span className="rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground dark:bg-white/[0.08]">
                      soon
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-[13px] text-muted-foreground">
                  {e.blurb}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {engine === "subprocess" && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[13px]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <span>
            <span className="font-medium">Heads up:</span> local subprocess runs
            model-generated code on your computer without a hard sandbox. It can
            read and write files and reach the network. Only use it with models
            you trust.
          </span>
        </div>
      )}
    </div>
  );
}

function GeneralSection({
  theme,
  setTheme,
}: {
  theme: "light" | "dark";
  setTheme: (t: "light" | "dark") => void;
}): JSX.Element {
  return (
    <div className="space-y-8">
      <section>
        <h3 className="text-base font-semibold">Appearance</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Choose how Claude Code looks on this device.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {(["light", "dark"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTheme(t)}
              className={cn(
                "rounded-xl border p-3 text-left transition-colors",
                theme === t
                  ? "border-foreground/40 ring-1 ring-foreground/20"
                  : "border-border hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
              )}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium capitalize">{t}</span>
                {theme === t && <Check className="size-4" />}
              </div>
              <div
                className={cn(
                  "flex h-16 gap-1 rounded-md border border-border p-1.5",
                  t === "light" ? "bg-[#f7f6f1]" : "bg-[#2a2926]",
                )}
              >
                <div
                  className={cn(
                    "w-1/3 rounded",
                    t === "light" ? "bg-[#e9e7df]" : "bg-[#201f1d]",
                  )}
                />
                <div
                  className={cn(
                    "flex-1 rounded",
                    t === "light" ? "bg-white" : "bg-[#323029]",
                  )}
                />
              </div>
            </button>
          ))}
        </div>
      </section>

      <StorageSection />
    </div>
  );
}

function AboutSection(): JSX.Element {
  const v = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI
    ?.versions;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-brand text-white">
          <svg viewBox="0 0 100 100" className="size-5" fill="none">
            <g stroke="currentColor" strokeWidth="9" strokeLinecap="round">
              <line x1="50" y1="16" x2="50" y2="84" />
              <line x1="16" y1="50" x2="84" y2="50" />
              <line x1="26" y1="26" x2="74" y2="74" />
              <line x1="74" y1="26" x2="26" y2="74" />
            </g>
          </svg>
        </div>
        <div>
          <div className="text-sm font-semibold">Claude Code Desktop</div>
          <div className="text-xs text-muted-foreground">Version 0.1.0</div>
        </div>
      </div>
      {v && (
        <p className="text-xs text-muted-foreground">
          Electron {v.electron} · Chromium {v.chrome} · Node {v.node}
        </p>
      )}
    </div>
  );
}

export function SettingsPanel({
  theme,
  setTheme,
}: {
  theme: "light" | "dark";
  setTheme: (t: "light" | "dark") => void;
}): JSX.Element {
  const [section, setSection] = useState<Section>("general");
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter(
      (it) =>
        !q ||
        it.label.toLowerCase().includes(q) ||
        g.group.toLowerCase().includes(q),
    ),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex h-full min-h-0">
      <nav className="w-52 shrink-0 overflow-y-auto border-r border-border bg-sidebar/60 p-3">
        {/* Search instead of the old "Settings" heading. */}
        <div className="mb-3 flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings"
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        {groups.length === 0 && (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            Nothing matches.
          </div>
        )}
        {groups.map((g) => (
          <div key={g.group} className="mb-3">
            <div className="px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground">
              {g.group}
            </div>
            {g.items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => setSection(it.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                  section === it.id
                    ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
                    : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]",
                )}
              >
                <it.icon className="size-4 shrink-0" />
                {it.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* Extra top padding keeps the first title/buttons clear of the
          dialog's close button in the top-right corner. */}
      <div className="min-w-0 flex-1 overflow-y-auto px-6 pb-6 pt-12">
        {section === "general" && (
          <GeneralSection theme={theme} setTheme={setTheme} />
        )}
        {section === "providers" && <ProviderSettings />}
        {section === "sandbox" && <SandboxSection />}
        {section === "automation" && <AutomationSettings />}
        {section === "skills" && <SkillsSettings />}
        {section === "connectors" && <ConnectorsSettings />}
        {section === "about" && <AboutSection />}
      </div>
    </div>
  );
}
