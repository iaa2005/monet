import { useState, useEffect } from "react";
import { Settings2, Boxes, Info, Check, FolderOpen } from "lucide-react";
import { ProviderSettings } from "@/components/providers/ProviderSettings";
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

type Section = "general" | "providers" | "about";

const NAV: {
  group: string;
  items: { id: Section; label: string; icon: typeof Settings2 }[];
}[] = [
  {
    group: "Settings",
    items: [
      { id: "general", label: "General", icon: Settings2 },
      { id: "providers", label: "Providers", icon: Boxes },
    ],
  },
  { group: "About", items: [{ id: "about", label: "About", icon: Info }] },
];

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

  return (
    <div className="flex h-full min-h-0">
      <nav className="w-52 shrink-0 overflow-y-auto border-r border-border bg-sidebar/60 p-3">
        <div className="px-2 pt-1 pb-3 text-sm font-semibold">Settings</div>
        {NAV.map((g) => (
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

      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        {section === "general" && (
          <GeneralSection theme={theme} setTheme={setTheme} />
        )}
        {section === "providers" && <ProviderSettings />}
        {section === "about" && <AboutSection />}
      </div>
    </div>
  );
}
