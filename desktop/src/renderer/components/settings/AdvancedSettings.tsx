/**
 * Advanced settings — opt-in tools (ToolSearch, LSP) and the tunable-prompts
 * folder. These map to <dataDir>/toolsearch.json, lsp.json and prompts/*.md.
 */
import { useEffect, useState } from "react";
import { FolderOpen, RotateCcw, Check } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { ElectronAPI } from "@/types/electron";
import { Select } from "@/components/ui/select";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function ToggleRow({
  title,
  desc,
  checked,
  onChange,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={checked} onChange={onChange} />
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
            model: p.model,
            models: (p.models ?? []).map((m: { name: string; label?: string }) => ({
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

  return (
    <div className="space-y-8">
      <section>
        <h3 className="text-base font-semibold">Advanced tools</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Optional capabilities, off by default. They apply to new messages.
        </p>
        <div className="mt-4 space-y-2">
          <ToggleRow
            title="ToolSearch (defer MCP tools)"
            desc="Don't advertise connector (MCP) tools upfront — the model is told which ones exist and loads the ones it needs on demand. Saves context when many connectors are attached. Works in Code and Home; in Home only connector-backed servers are reachable."
            checked={toolSearch}
            onChange={toggleToolSearch}
          />
          <ToggleRow
            title="LSP (code intelligence)"
            desc="Definitions, references, hover, symbols and diagnostics via a language server. Needs the server installed (typescript-language-server, pyright, gopls, rust-analyzer, clangd). Code only."
            checked={lsp}
            onChange={toggleLsp}
          />
          <ToggleRow
            title="Caveman mode (terse)"
            desc="The agent writes super-terse output and thinking — telegraphic, no filler — and squeezes context earlier and tighter. Reinforced on every turn, not just in the system prompt. Great for saving tokens on weaker/cheaper models."
            checked={caveman}
            onChange={toggleCaveman}
          />
          <ToggleRow
            title="Lean tool descriptions"
            desc="Strip worked examples from tool descriptions, keeping every rule. Measured on this app: TodoWrite 9114 → 3288 characters, ~1.6K tokens saved on every request."
            checked={leanTools}
            onChange={toggleLeanTools}
          />
        </div>
      </section>

      <section>
        <h3 className="text-base font-semibold">Background model</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Which model does the work that isn't the conversation: noting memory
          after a turn, the nightly consolidation, the Reflect digest, drafting a
          routine. Leave on the active provider, or point it at something cheap —
          including a local Ollama / LM Studio / llama.cpp server, which needs no
          API key.
        </p>
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
        <h3 className="text-base font-semibold">Prompts</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          The system prompt, mode directives and every tool description are
          editable Markdown files. Open the folder, edit a file, then reload (or
          restart) to apply — delete a file to restore its default.
        </p>
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
