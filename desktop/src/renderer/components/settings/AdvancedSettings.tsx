/**
 * Advanced settings — opt-in tools (ToolSearch, LSP) and the tunable-prompts
 * folder. These map to <dataDir>/toolsearch.json, lsp.json and prompts/*.md.
 */
import { useEffect, useState } from "react";
import {
  FolderOpen,
  RotateCcw,
  Check,
  Telescope,
  CircleCheck,
  Compass,
  Eye,
  Gavel,
  GraduationCap,
  Layers,
  MessageCircleQuestion,
  NotebookPen,
  Palette,
  PlaneLanding,
  PlayCircle,
  Search,
  ShieldCheck,
  Wind,
  Zap,
  type LucideIcon,
} from "@/components/icons/hg";
import { Switch } from "@/components/ui/switch";
import type { ElectronAPI } from "@/types/electron";
import { Select } from "@/components/ui/select";
import { SettingCard } from "./SettingCard";
import {
  FEATURES,
  defaultFeatures,
  type FeatureFlags,
  type FeatureSpec,
} from "@shared/agent-features";
import {
  SectionHeader,
  SectionTitle,
} from "@/components/settings/SectionTitle";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** Only Windows has two shells to choose between. */
function isWindows(): boolean {
  return (
    (window as unknown as { electronAPI?: { platform?: string } }).electronAPI
      ?.platform === "win32"
  );
}

/** The icons the feature registry names. Resolved here rather than stored as
 * components: shared/ is imported by main too, and main has no lucide. */
const ICONS: Record<string, LucideIcon> = {
  Telescope,
  CircleCheck,
  Compass,
  Eye,
  Gavel,
  GraduationCap,
  Layers,
  MessageCircleQuestion,
  NotebookPen,
  Palette,
  PlaneLanding,
  PlayCircle,
  Search,
  ShieldCheck,
  Wind,
  Zap,
};

/** What turning it on costs, said plainly — the thing a switch usually hides. */
const COST_LABEL: Record<FeatureSpec["cost"], string> = {
  free: "no extra cost",
  tokens: "extra tokens",
  time: "extra time",
};

function ToggleRow({
  title,
  desc,
  icon,
  cost,
  checked,
  onChange,
}: {
  title: string;
  desc: string;
  icon?: string;
  cost?: FeatureSpec["cost"];
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <SettingCard
      icon={(icon && ICONS[icon]) || Zap}
      title={title}
      description={desc}
      on={checked}
      badge={
        cost && cost !== "free" ? (
          <span className="rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground">
            {COST_LABEL[cost]}
          </span>
        ) : undefined
      }
      control={<Switch checked={checked} onChange={onChange} />}
    />
  );
}

/** Seconds, as a number box that cannot be left in a half-typed state. */
function SecondsField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <label className="text-[13px] font-medium">{label}</label>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="number"
          min={0}
          step={30}
          value={value}
          // Committed on blur, not on every keystroke: typing "1800" passes
          // through 1, 18 and 180, and writing each of those would leave the
          // file holding whichever one the user paused on.
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-foreground/20"
        />
        <span className="text-xs text-muted-foreground">
          {value === 0 ? "never give up" : "seconds of silence"}
        </span>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function AdvancedSettings(): JSX.Element {
  const [toolSearch, setToolSearch] = useState(false);
  const [lsp, setLsp] = useState(false);
  const [caveman, setCaveman] = useState(false);
  const [leanTools, setLeanTools] = useState(true);
  const [reloaded, setReloaded] = useState(false);
  const [promptsDir, setPromptsDir] = useState<string>("");
  const [providers, setProviders] = useState<
    { id: string; name: string; model: string; models: { name: string; label?: string }[] }[]
  >([]);
  const [bgProvider, setBgProvider] = useState("");
  const [bgModel, setBgModel] = useState("");
  const [features, setFeatures] = useState<FeatureFlags>(defaultFeatures());
  const [timeouts, setTimeouts] = useState({ remoteSec: 300, localSec: 1800 });
  const [shell, setShell] = useState<"auto" | "bash" | "powershell" | "both">(
    "auto",
  );

  const toggleFeature = (id: keyof FeatureFlags, v: boolean): void => {
    setFeatures((prev) => ({ ...prev, [id]: v }));
    void api()?.tuning.featuresSet({ [id]: v });
  };

  // Changing the provider clears the model: a model name from one provider is
  // meaningless on another, and silently keeping it would route background work
  // to a model that does not exist there.
  const saveRouting = (providerId: string, model: string): void => {
    setBgProvider(providerId);
    setBgModel(model);
    void api()?.providers.routingSet({
      backgroundProviderId: providerId,
      backgroundModel: model,
    });
  };

  useEffect(() => {
    api()?.tuning.featuresGet().then(setFeatures).catch(() => {});
    api()?.tuning.timeoutsGet().then(setTimeouts).catch(() => {});
    api()?.tuning.shellGet().then((c) => setShell(c.choice)).catch(() => {});
    api()?.tuning.toolSearchGet().then((c) => setToolSearch(c.enabled)).catch(() => {});
    api()?.tuning.lspGet().then((c) => setLsp(c.enabled)).catch(() => {});
    api()?.tuning.cavemanGet().then((c) => setCaveman(c.enabled)).catch(() => {});
    api()
      ?.tuning.leanGet()
      .then((c) => setLeanTools(c.leanTools))
      .catch(() => {});
    void api()
      ?.providers.list()
      .then((list) =>
        setProviders(
          list.map((p) => ({
            id: p.id,
            name: p.name,
            // The provider's own default, for the "Default (…)" option —
            // derived from which model is selected, because that is where the
            // answer lives. It used to read a flat `model` field off the
            // stored record, and providers:list does not resolve one: the
            // label showed whatever the form last wrote there, not the model
            // this provider would actually use.
            model:
              p.models?.find((m) => m.id === p.activeModelId)?.name ??
              p.models?.[0]?.name ??
              "",
            models: (p.models ?? []).map((m) => ({
              name: m.name,
              label: m.label,
            })),
          })),
        ),
      )
      .catch(() => {});
    void api()
      ?.providers.routingGet()
      .then((r) => {
        setBgProvider(r.backgroundProviderId);
        setBgModel(r.backgroundModel);
      })
      .catch(() => {});
  }, []);

  const saveTimeout = (patch: { remoteSec?: number; localSec?: number }): void => {
    setTimeouts((prev) => ({ ...prev, ...patch }));
    void api()?.tuning.timeoutsSet(patch);
  };

  const saveShell = (choice: "auto" | "bash" | "powershell" | "both"): void => {
    setShell(choice);
    void api()?.tuning.shellSet({ choice });
  };

  const toggleToolSearch = (v: boolean): void => {
    setToolSearch(v);
    void api()?.tuning.toolSearchSet({ enabled: v });
  };
  const toggleCaveman = (v: boolean): void => {
    setCaveman(v);
    void api()?.tuning.cavemanSet({ enabled: v });
  };
  const toggleLeanTools = (v: boolean): void => {
    setLeanTools(v);
    void api()?.tuning.leanSet({ leanTools: v });
  };
  const toggleLsp = (v: boolean): void => {
    setLsp(v);
    void api()?.tuning.lspSet({ enabled: v });
  };

  const reload = async (): Promise<void> => {
    await api()?.tuning.promptsReload();
    setReloaded(true);
    window.setTimeout(() => setReloaded(false), 1500);
  };
  const reveal = async (): Promise<void> => {
    const r = await api()?.tuning.promptsReveal();
    if (r?.dir) setPromptsDir(r.dir);
  };

  const groups = [
    "Before the work",
    "Habits",
    "Checking the work",
    "Recovery",
    "Between runs",
  ] as const;

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader
        title="How the agent works"
        description="A weaker model does not fail at doing — it fails at deciding when. These are the decisions the harness makes for it: verification that happens to it, a first turn it cannot write in, a reader it did not ask for. Each costs something on the turns it was not needed, which is why each one is a switch."
      />
        {groups.map((group) => {
          const inGroup = FEATURES.filter((f) => f.group === group);
          if (!inGroup.length) return null;
          return (
            <div key={group} className="mt-5">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group}
              </h4>
              <div className="mt-2 grid gap-2">
                {inGroup.map((f) => (
                  <ToggleRow
                    key={f.id}
                    title={f.name}
                    desc={f.description}
                    icon={f.icon}
                    cost={f.cost}
                    checked={features[f.id]}
                    onChange={(v) => toggleFeature(f.id, v)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <section>
        <SectionHeader
        title="Advanced tools"
        description="Optional capabilities, off by default. They apply to new messages."
      />
        <div className="mt-4 grid gap-2">
          <ToggleRow
            icon="Search"
            title="Load rarely-used tools on demand (ToolSearch)"
            desc="Keep the tools most messages never touch out of the standing toolset — connector (MCP) tools, and the app's own: the Obsidian six, routines, skills, swarms, the notebook editor. The model is told by name what exists and loads what it needs, which costs it one extra step on the turns it needs one. Measured on a Code turn with a vault and LSP on: 20,444 tokens down to 15,719."
            checked={toolSearch}
            onChange={toggleToolSearch}
          />
          <ToggleRow
            icon="Layers"
            title="LSP (code intelligence)"
            desc="Definitions, references, hover, symbols and diagnostics via a language server. Needs the server installed (typescript-language-server, pyright, gopls, rust-analyzer, clangd). Code only."
            checked={lsp}
            onChange={toggleLsp}
          />
          <ToggleRow
            icon="Wind"
            title="Caveman mode (terse)"
            desc="The agent writes super-terse output and thinking — telegraphic, no filler — and squeezes context earlier and tighter. Reinforced on every turn, not just in the system prompt. Great for saving tokens on weaker/cheaper models."
            checked={caveman}
            onChange={toggleCaveman}
          />
          <ToggleRow
            icon="Zap"
            title="Lean tool descriptions"
            desc="Strip worked examples from tool descriptions, keeping every rule. Measured on this app: TodoWrite 9114 → 3288 characters, ~1.6K tokens saved on every request."
            checked={leanTools}
            onChange={toggleLeanTools}
          />
        </div>
      </section>

      {isWindows() && (
        <section>
          <SectionHeader
            title="Shell"
            description="Windows has two, and the model used to be handed both — 4,551 tokens of the two largest tool descriptions in the toolset, to say the same thing twice, on every turn. One is enough, and which one is a real preference: the commands are not interchangeable in the details."
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select
              ariaLabel="Shell offered to the model"
              value={shell}
              onChange={(v) => saveShell(v as "auto" | "bash" | "powershell" | "both")}
              className="py-1.5 text-sm"
              options={[
                { value: "auto", label: "Bash if Git Bash is installed, else PowerShell" },
                { value: "bash", label: "Bash only" },
                { value: "powershell", label: "PowerShell only" },
                { value: "both", label: "Both (costs ~1,800 extra tokens a turn)" },
              ]}
            />
          </div>
        </section>
      )}

      <section>
        <SectionHeader
          title="Waiting for a model"
          description="How long a model may say nothing before the app gives up on the answer. It measures SILENCE, not total time: every byte that arrives restarts the clock. A model on this computer reads a long prompt for minutes before its first word, and five minutes of that is normal — which is why the two numbers are separate. 0 means wait as long as it takes."
        />
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <SecondsField
            label="A model over the network"
            hint="An API that has said nothing for five minutes is broken."
            value={timeouts.remoteSec}
            onChange={(v) => saveTimeout({ remoteSec: v })}
          />
          <SecondsField
            label="A model on this computer"
            hint="Reading the prompt is the slow part; the app shows how far it has got."
            value={timeouts.localSec}
            onChange={(v) => saveTimeout({ localSec: v })}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          A single model can override both in Settings → Providers.
        </p>
      </section>

      <section>
        <SectionHeader
        title="Background model"
        description="Which model does the work that isn't the conversation: noting memory after a turn, the nightly consolidation, the Reflect digest, drafting a routine. Leave on the active provider, or point it at something cheap — including a local Ollama / LM Studio / llama.cpp server, which needs no API key."
      />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select
            ariaLabel="Background provider"
            value={bgProvider}
            onChange={(v) => saveRouting(v, "")}
            className="py-1.5 text-sm"
            options={[
              { value: "", label: "Same as the active provider" },
              ...providers.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          {bgProvider && (
            <Select
              ariaLabel="Background model"
              value={bgModel}
              onChange={(v) => saveRouting(bgProvider, v)}
              className="min-w-[16rem] py-1.5 text-sm"
              options={[
                {
                  value: "",
                  label: providers.find((p) => p.id === bgProvider)?.model
                    ? `Default (${providers.find((p) => p.id === bgProvider)?.model})`
                    : "That provider's default",
                },
                ...(providers.find((p) => p.id === bgProvider)?.models ?? []).map(
                  (m) => ({ value: m.name, label: m.label || m.name }),
                ),
              ]}
            />
          )}
        </div>
      </section>

      <section>
        <SectionHeader
        title="Prompts"
        description="The system prompt, mode directives and every tool description are editable Markdown files. Open the folder, edit a file, then reload (or restart) to apply — delete a file to restore its default."
      />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void reveal()}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
          >
            <FolderOpen className="size-4" />
            Open prompts folder
          </button>
          <button
            type="button"
            onClick={() => void reload()}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
          >
            {reloaded ? <Check className="size-4 text-green-text" /> : <RotateCcw className="size-4" />}
            {reloaded ? "Reloaded" : "Reload prompts"}
          </button>
        </div>
        {promptsDir && (
          <p className="mt-2 truncate font-mono text-xs text-muted-foreground" title={promptsDir}>
            {promptsDir}
          </p>
        )}
      </section>

    </div>
  );
}
