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
            title="ToolSearch (defer MCP tools)"
            desc="Don't advertise connector (MCP) tools upfront — the model is told which ones exist and loads the ones it needs on demand. Saves context when many connectors are attached. Works in Code and Home; in Home only connector-backed servers are reachable."
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
