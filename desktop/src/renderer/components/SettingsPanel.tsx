import { useState, useEffect, type ComponentType } from "react";
import {
  Box,
  Container,
  TerminalSquare,
  type LucideIcon,
  Settings,
  Settings2,
  TextCursor,
  Mic,
  Boxes,
  Check,
  Copy,
  FolderOpen,
  BookMarked,
  Bot,
  Brain,
  Sun,
  Plug,
  Search,
  FlaskConical,
  AlertTriangle,
  MousePointerClick,
  Loader2,
  Palette,
  SlidersHorizontal,
  FileScan,
} from "lucide-react";
import { EditorSettings } from "@/components/settings/EditorSettings";
import { ObsidianSettings } from "@/components/settings/ObsidianSettings";
import { OcrSettings } from "@/components/settings/OcrSettings";
import { ObsidianIcon } from "@/components/ObsidianIcon";
import { ProviderSettings } from "@/components/providers/ProviderSettings";
import { SkillsSettings } from "@/components/settings/SkillsSettings";
import { AgentsSettings } from "@/components/settings/AgentsSettings";
import { MemorySettings } from "@/components/settings/MemorySettings";
import { ProfileSection } from "@/components/settings/ProfileSection";
import { ReflectSettings } from "@/components/settings/ReflectSettings";
import { ConnectorsSettings } from "@/components/settings/ConnectorsSettings";
import { AutomationSettings } from "@/components/settings/AutomationSettings";
import { AdvancedSettings } from "@/components/settings/AdvancedSettings";
import { VoiceSettings } from "@/components/settings/VoiceSettings";
import { ProtocolConnectors } from "@/components/settings/ProtocolConnectors";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";
import { PickCard } from "@/components/settings/PickCard";
import { SandboxImageSettings } from "@/components/settings/SandboxImageSettings";
import {
  SectionHeader,
  SectionTitle,
} from "@/components/settings/SectionTitle";

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
      <SectionHeader
        title="Data folder"
        description="Where chats, sessions and settings are stored. Changing it takes effect after a restart."
      />
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
  | "editor"
  | "voice"
  | "providers"
  | "sandbox"
  | "automation"
  | "memory"
  | "reflect"
  | "advanced"
  | "skills"
  | "agents"
  | "services"
  | "connectors"
  | "obsidian"
  | "ocr";

const NAV: {
  group: string;
  // Any icon component with a className — lucide icons and the app's own
  // (ObsidianIcon) alike; typeof Settings2 demanded lucide's forwardRef shape.
  items: { id: Section; label: string; icon: ComponentType<{ className?: string }> }[];
}[] = [
  {
    group: "Settings",
    items: [
      { id: "general", label: "General", icon: Settings },
      // The editor is where text is edited, not where the theme is picked —
      // the palette named the one setting on the tab that is not about typing.
      { id: "editor", label: "Editor", icon: TextCursor },
      { id: "providers", label: "Providers", icon: Boxes },
      // A container, because that is literally what the sandbox is now. The
      // flask was from when it was a Pyodide scratchpad.
      { id: "sandbox", label: "Sandbox", icon: Container },
      { id: "automation", label: "Automation", icon: MousePointerClick },
      { id: "voice", label: "Voice", icon: Mic },
      { id: "memory", label: "Memory", icon: Brain },
      { id: "reflect", label: "Reflect", icon: Sun },
      { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
    ],
  },
  {
    group: "Customize",
    items: [
      { id: "skills", label: "Skills", icon: BookMarked },
      { id: "agents", label: "Agents", icon: Bot },
      { id: "obsidian", label: "Obsidian", icon: ObsidianIcon },
      { id: "ocr", label: "OCR Scanner", icon: FileScan },
      { id: "services", label: "Connectors", icon: Boxes },
      { id: "connectors", label: "MCP Servers", icon: Plug },
    ],
  },
];

const SANDBOX_ENGINES: {
  id: string;
  title: string;
  blurb: string;
  icon: LucideIcon;
  warn?: boolean;
  disabled?: boolean;
}[] = [
  {
    id: "pyodide",
    icon: Box,
    title: "Pyodide (Python in WebAssembly)",
    blurb:
      "Default. Python and JavaScript run inside the app, fully isolated — no access to your files or network. Great for documents, tables and charts (pandas, matplotlib, python-docx, openpyxl).",
  },
  {
    id: "subprocess",
    icon: TerminalSquare,
    title: "Local subprocess (real Python / Node)",
    blurb:
      "Runs real python/node in a per-chat temp folder. Full power, but code executes on your machine WITHOUT hard isolation — use only with models you trust.",
    warn: true,
  },
  {
    id: "docker",
    icon: Container,
    title: "Podman container",
    blurb:
      "Real Python + Node + LaTeX (tectonic) in an isolated container. The portable Podman CLI is provisioned automatically — no manual install. The Linux backend (WSL2) and the shared image build once on first use; chats then add only copy-on-write layers, not gigabytes.",
  },
];

function SandboxSection(): JSX.Element {
  const [engine, setEngine] = useState<string>("pyodide");
  const [podmanStatus, setPodmanStatus] = useState<string | null>(null);
  const [podmanReady, setPodmanReady] = useState<boolean | null>(null);
  const [needsWsl, setNeedsWsl] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyInstallCommand = async (): Promise<void> => {
    await navigator.clipboard.writeText("wsl.exe --install");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  // Non-destructive status refresh — must NOT run the heavy checkPodman (which
  // inits/starts/restarts the machine) just because Settings opened.
  const refreshReady = async (): Promise<void> => {
    const r = await api()?.sandbox.isPodmanReady();
    setPodmanReady(!!r?.ok);
    if (r?.ok) {
      setNeedsWsl(false);
      setPodmanStatus(null);
    }
  };

  useEffect(() => {
    api()
      ?.sandbox.getConfig()
      .then((c) => {
        setEngine(c.engine);
        if (c.engine === "docker") void refreshReady();
      })
      .catch(() => {});
  }, []);

  const choose = (id: string): void => {
    setEngine(id);
    void api()?.sandbox.setConfig({ engine: id });
    if (id === "docker") {
      setPodmanReady(null);
      setPodmanStatus(null);
      void refreshReady();
    }
  };

  const preparePodman = async (): Promise<void> => {
    setPreparing(true);
    setPodmanStatus(
      "Provisioning Podman… (first time: downloads the CLI and starts the Linux backend — this can take a few minutes)",
    );
    try {
      const r = await api()?.sandbox.preparePodman();
      setPodmanReady(!!r?.ok);
      setNeedsWsl(!!r?.needsWsl);
      setPodmanStatus(
        r?.ok
          ? "Podman is ready. Run Python will work in new sessions."
          : r?.needsWsl
            ? "WSL2 isn't installed yet — run wsl.exe --install, then click Install / prepare again."
            : `Podman setup failed: ${r?.error ?? "unknown error"}`,
      );
    } finally {
      setPreparing(false);
    }
  };

  return (
    <div className="space-y-4">
      <section>
        <SectionHeader
        title="Sandbox"
        description="Where Home runs generated code (Python and scripts for documents, tables and charts). Home is isolated from your project — Code mode works directly with your files instead."
      />
      </section>

      <div className="space-y-2">
        {SANDBOX_ENGINES.map((e) => {
          const active = engine === e.id;
          return (
            <PickCard
              key={e.id}
              icon={e.icon}
              title={e.title}
              badge={
                <>
                  {e.warn && <AlertTriangle className="size-3.5 text-amber-500" />}
                  {e.disabled && (
                    <span className="rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground dark:bg-white/[0.08]">
                      soon
                    </span>
                  )}
                </>
              }
              description={e.blurb}
              selected={active}
              disabled={e.disabled}
              onClick={() => !e.disabled && choose(e.id)}
            />
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

      {engine === "docker" && podmanReady !== true && (
        <div className="grid gap-3 rounded-xl border border-amber-500/50 bg-amber-500/10 px-3 py-2.5 text-[13px]">
          <div className="min-w-0 text-amber-900 dark:text-amber-200">
            <div className="font-medium">
              {needsWsl ? "WSL2 backend required" : "Podman isn't ready yet"}
            </div>
            <div className="mt-0.5 text-amber-800/80 dark:text-amber-200/80">
              {needsWsl ? (
                <>
                  Podman needs the WSL2 backend to run Linux containers. Install
                  it once (below), then click Install / prepare — the portable
                  Podman CLI and container image are set up automatically.
                </>
              ) : (
                <>
                  The portable Podman CLI is set up automatically. Click Install /
                  prepare to download it and start the Linux backend — the first
                  time can take a few minutes. Run Python works once it's ready.
                </>
              )}
            </div>
            {needsWsl && (
              <div className="mt-2 space-y-1.5 text-xs text-amber-800/80 dark:text-amber-200/80">
                <div className="italic">In an Administrator PowerShell, run:</div>
                <div className="flex items-center gap-2 rounded-md border border-amber-600/30 bg-amber-500/10 px-2 py-1.5">
                  <code className="min-w-0 flex-1 font-mono">wsl.exe --install</code>
                  <button
                    type="button"
                    onClick={() => void copyInstallCommand()}
                    className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 font-medium hover:bg-amber-500/15"
                    title="Copy installation command"
                  >
                    <Copy className="size-3" />
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="italic">Restart Windows if prompted, then return here and click Install / prepare again.</div>
              </div>
            )}
            {podmanStatus && <div className="mt-2 break-words text-xs italic">{podmanStatus}</div>}
          </div>
          <button
            type="button"
            onClick={() => void preparePodman()}
            disabled={preparing}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-amber-600/40 px-2.5 py-1 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-70 dark:text-amber-200 w-fit ml-auto"
          >
            {preparing && <Loader2 className="size-3 animate-spin" />}
            {preparing ? "Preparing…" : "Install / prepare"}
          </button>
        </div>
      )}

      {engine === "docker" && podmanReady === true && (
        <div className="rounded-xl border border-green-border bg-green-bg px-3 py-2.5 text-[13px] text-green-text">
          Podman is ready. Run Python is available in Home sessions.
        </div>
      )}

      {/* Always here, whatever engine is selected — see the note in the
          component: it is also how anyone finds out the option exists. */}
      <SandboxImageSettings engine={engine} />
    </div>
  );
}

/** Keep the machine awake. Reflects the LIVE blocker, not just the stored flag —
 * if the OS declined to hold it, the toggle must not claim otherwise. */
function KeepAwakeSection(): JSX.Element {
  const [on, setOn] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    void api()
      ?.tuning.powerGet()
      .then((c) => {
        setOn(c.keepAwake);
        setActive(c.active);
      })
      .catch(() => {});
  }, []);

  const toggle = (v: boolean): void => {
    setOn(v);
    void api()
      ?.tuning.powerSet({ keepAwake: v })
      .then((c) => {
        setOn(c.keepAwake);
        setActive(c.active);
      })
      .catch(() => {});
  };

  return (
    <section>
      <SectionHeader
        title="Power"
        description="How this device behaves while Code Monet is running."
      />
      {/* A filled card, not an outlined one: on a white sheet the surface
          change is the edge, and one less hairline on the screen. */}
      <div className="mt-3 flex items-start justify-between gap-3.5 rounded-[var(--radius)] bg-muted px-3.5 py-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">Keep awake</div>
          <p className="mt-0.5 text-[13px] font-medium leading-5 text-muted-foreground">
            Stop this computer going to sleep on its own, so a long run isn&apos;t
            cut off mid-task and a scheduled routine actually fires. The screen
            still turns off as usual. It can&apos;t wake a sleeping machine, and
            it won&apos;t override closing the lid.
          </p>
          {on && !active && (
            <p className="mt-1 text-[13px] text-destructive">
              The system declined the request — sleep isn&apos;t being blocked.
            </p>
          )}
        </div>
        <Switch checked={on} onChange={toggle} />
      </div>
    </section>
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
      <ProfileSection />
      <KeepAwakeSection />
      <section>
        <SectionHeader
        title="Appearance"
        description="Choose how Code Monet looks on this device."
      />
        <div className="mt-4 grid grid-cols-2 gap-3">
          {(["light", "dark"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTheme(t)}
              className={cn(
                // Chosen = the brand wash inside a brand edge, the same pair
                // the whole app uses for "this one". A ring plus a darker
                // border was a third way of saying selected.
                "rounded-[var(--radius)] border px-3 pb-3 pt-2.5 text-left transition-colors",
                theme === t
                  ? "border-brand-edge bg-brand-wash"
                  : "border-border hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
              )}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[13px] font-medium capitalize">{t}</span>
                {theme === t && <Check className="size-[15px] text-brand" />}
              </div>
              {/* A miniature of the real thing: chrome, sidebar, canvas.
                  These were four warm hexes from an earlier palette and
                  matched nothing on screen — the light swatch was cream
                  while the app was grey. Painted from the tokens now, so
                  the preview cannot drift from what it previews. */}
              <div
                className={cn(
                  "flex h-16 gap-1 rounded-md border border-border p-1.5",
                  t === "light" ? "bg-[hsl(220_5%_97%)]" : "bg-[hsl(0_0%_9.4%)]",
                )}
              >
                <div
                  className={cn(
                    "w-1/3 rounded",
                    t === "light" ? "bg-[hsl(220_4%_95%)]" : "bg-[hsl(0_0%_12.2%)]",
                  )}
                />
                <div
                  className={cn(
                    "flex-1 rounded",
                    t === "light" ? "bg-white" : "bg-[hsl(0_0%_7.1%)]",
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

export function SettingsPanel({
  theme,
  setTheme,
  initialSection = "general",
}: {
  theme: "light" | "dark";
  setTheme: (t: "light" | "dark") => void;
  initialSection?: Section;
}): JSX.Element {
  const [section, setSection] = useState<Section>(initialSection);
  const [query, setQuery] = useState("");

  useEffect(() => setSection(initialSection), [initialSection]);

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
      {/* One sheet, not two panes: no rule down the middle and no surface of
          its own. The selected chip is what marks the column, and the dialog's
          own edge is the only border on the screen. */}
      <nav className="w-52 shrink-0 overflow-y-auto p-3">
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
            <div className="pb-1 pl-1 pt-4 text-[12px] font-medium text-muted-foreground">
              {g.group}
            </div>
            {g.items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => setSection(it.id)}
                className={cn(
                  // The open section is branded like every other current thing,
                  // and carries a hairline of brand so it reads as a chip and
                  // not just a tint. Unselected rows are plain ink, not muted:
                  // this is a list of places to go, none of them disabled.
                  "flex h-8 w-full items-center gap-[9px] rounded-md px-2.5 text-[13px] font-medium transition-colors",
                  section === it.id
                    ? "border border-brand/50 bg-brand-wash text-brand"
                    : "border border-transparent text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
                )}
              >
                <it.icon className="size-[15px] shrink-0" />
                {it.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* Top padding keeps the first title clear of the dialog's close button
          in the corner; the sides are narrow because the nav beside it already
          holds the content off the edge. */}
      <div className="min-w-0 flex-1 overflow-y-auto px-3 pb-6 pt-6">
        {section === "general" && (
          <GeneralSection theme={theme} setTheme={setTheme} />
        )}
        {section === "editor" && <EditorSettings />}
        {section === "providers" && <ProviderSettings />}
        {section === "sandbox" && <SandboxSection />}
        {section === "automation" && <AutomationSettings />}
        {section === "voice" && <VoiceSettings />}
        {section === "memory" && <MemorySettings />}
        {section === "reflect" && <ReflectSettings />}
        {section === "obsidian" && <ObsidianSettings />}
        {section === "ocr" && <OcrSettings />}
        {section === "services" && <ProtocolConnectors />}
        {section === "advanced" && <AdvancedSettings />}
        {section === "skills" && <SkillsSettings />}
        {section === "agents" && <AgentsSettings />}
        {section === "connectors" && <ConnectorsSettings />}
      </div>
    </div>
  );
}
