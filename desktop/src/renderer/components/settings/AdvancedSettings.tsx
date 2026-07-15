/**
 * Advanced settings — opt-in tools (ToolSearch, LSP) and the tunable-prompts
 * folder. These map to <dataDir>/toolsearch.json, lsp.json and prompts/*.md.
 */
import { useEffect, useState } from "react";
import { FolderOpen, RotateCcw, Check } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { ElectronAPI } from "@/types/electron";

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
  const [reloaded, setReloaded] = useState(false);
  const [promptsDir, setPromptsDir] = useState<string>("");

  useEffect(() => {
    api()?.tuning.toolSearchGet().then((c) => setToolSearch(c.enabled)).catch(() => {});
    api()?.tuning.lspGet().then((c) => setLsp(c.enabled)).catch(() => {});
  }, []);

  const toggleToolSearch = (v: boolean): void => {
    setToolSearch(v);
    void api()?.tuning.toolSearchSet({ enabled: v });
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
            desc="Don't advertise connector (MCP) tools upfront — the model searches for and loads them on demand. Saves context when many connectors are attached. Code only."
            checked={toolSearch}
            onChange={toggleToolSearch}
          />
          <ToggleRow
            title="LSP (code intelligence)"
            desc="Definitions, references, hover, symbols and diagnostics via a language server. Needs the server installed (typescript-language-server, pyright, gopls, rust-analyzer, clangd). Code only."
            checked={lsp}
            onChange={toggleLsp}
          />
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
            {reloaded ? <Check className="size-4 text-emerald-500" /> : <RotateCcw className="size-4" />}
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
