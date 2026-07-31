import { useEffect, useMemo, useState } from "react";
import { Bot, Code, Eye, Lock, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownViewer } from "@/components/chat/MarkdownViewer";
import type { AgentSummary, ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

interface ModelOption {
  name: string;
  label: string;
}

/** Drop the YAML frontmatter for a cleaner markdown preview of the body. */
function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  return m ? m[1] : md;
}

function ModalShell({
  title,
  onClose,
  size = "lg",
  children,
}: {
  title: string;
  onClose: () => void;
  size?: "lg" | "xl" | "2xl" | "3xl";
  children: React.ReactNode;
}): JSX.Element {
  const width = {
    lg: "max-w-lg",
    xl: "max-w-xl",
    "2xl": "max-w-2xl",
    "3xl": "max-w-3xl",
  }[size];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={cn(
          "flex max-h-[88vh] w-full flex-col rounded-lg border border-border bg-card p-5 shadow-xl",
          width,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const INPUT =
  "mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground/20";

function NewAgentModal({
  tools,
  models,
  taken,
  onClose,
  onCreated,
}: {
  tools: string[];
  models: ModelOption[];
  taken: Set<string>;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duplicate = name.trim() !== "" && taken.has(name.trim().toLowerCase());

  const toggleTool = (t: string): void => {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const create = async (): Promise<void> => {
    if (!name.trim()) return setError("Agent name is required");
    if (duplicate) return setError("An agent with that name already exists");
    if (!prompt.trim()) return setError("System prompt is required");
    setBusy(true);
    setError(null);
    try {
      await api()?.agents.create({
        name,
        description,
        prompt,
        tools: [...selectedTools],
        model: model || undefined,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
      setBusy(false);
    }
  };

  return (
    <ModalShell title="New agent" onClose={onClose} size="2xl">
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <label className="block text-sm font-medium">Name (agent type)</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="code-reviewer"
          className={cn(INPUT, duplicate && "border-destructive")}
        />
        {duplicate && (
          <p className="mt-1 text-xs text-destructive">
            An agent named “{name.trim()}” already exists.
          </p>
        )}

        <label className="mt-4 block text-sm font-medium">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="When the main agent should delegate to this type. The model reads this to route subagent_type."
          rows={2}
          className={cn(INPUT, "resize-none")}
        />

        <div className="mt-4">
          <label className="block text-sm font-medium">
            Tools <span className="text-muted-foreground">(optional)</span>
          </label>
          <p className="mb-1.5 mt-0.5 text-xs text-muted-foreground">
            Leave all unchecked for the full toolset. Checking some restricts
            the sub-agent to exactly those (it never gets Task).
          </p>
          <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border p-2 sm:grid-cols-3">
            {tools.map((t) => (
              <label
                key={t}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <input
                  type="checkbox"
                  checked={selectedTools.has(t)}
                  onChange={() => toggleTool(t)}
                  className="size-3.5 accent-violet-500"
                />
                <span className="truncate">{t}</span>
              </label>
            ))}
            {tools.length === 0 && (
              <span className="text-xs text-muted-foreground">
                No tools available.
              </span>
            )}
          </div>
        </div>

        <label className="mt-4 block text-sm font-medium">Model</label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className={INPUT}
        >
          <option value="">Inherit — use the chat’s model</option>
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.label}
            </option>
          ))}
        </select>

        <label className="mt-4 block text-sm font-medium">System prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="You are a … agent. Given the task, …"
          rows={7}
          className={cn(INPUT, "resize-none font-mono text-xs leading-relaxed")}
        />

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      </div>

      <div className="mt-4 flex justify-end gap-2 border-t border-border pt-4">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || duplicate}
          onClick={() => void create()}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Create
        </button>
      </div>
    </ModalShell>
  );
}

function EditAgentModal({
  slug,
  onClose,
  onChanged,
}: {
  slug: string;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api()
      ?.agents.getRaw(slug)
      .then((r) => {
        if (r.ok) setDraft(r.content ?? "");
        else setError(r.error ?? "Failed to read agent");
      })
      .catch((e) => setError(String(e)));
  }, [slug]);

  const save = async (): Promise<void> => {
    if (draft == null) return;
    setBusy(true);
    const r = await api()?.agents.writeRaw(slug, draft);
    setBusy(false);
    if (r?.ok) {
      onChanged();
      onClose();
    } else setError(r?.error ?? "Failed to save");
  };

  return (
    <ModalShell title={`Edit ${slug}.md`} onClose={onClose} size="3xl">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex gap-0.5 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.05]">
          <button
            type="button"
            onClick={() => setView("edit")}
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
              view === "edit"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Code className="size-3.5" /> Edit
          </button>
          <button
            type="button"
            onClick={() => setView("preview")}
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
              view === "preview"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Eye className="size-3.5" /> Preview
          </button>
        </div>
        <span className="text-xs text-muted-foreground">
          YAML frontmatter (name / description / tools / model / effort) + system
          prompt
        </span>
      </div>

      {error && <p className="mb-3 text-xs text-destructive">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {draft == null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : view === "edit" ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-[56vh] w-full resize-none rounded-lg border border-border bg-background p-3 font-mono text-xs leading-relaxed outline-none focus:ring-1 focus:ring-foreground/20"
          />
        ) : (
          <div className="h-[56vh] overflow-y-auto rounded-lg border border-border bg-background p-4">
            <MarkdownViewer content={stripFrontmatter(draft)} />
          </div>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2 border-t border-border pt-4">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || draft == null}
          onClick={() => void save()}
          className="rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

export function AgentsSettings(): JSX.Element {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modal, setModal] = useState<"none" | "new">("none");
  const [editSlug, setEditSlug] = useState<string | null>(null);

  const load = (): void => {
    api()
      ?.agents.list()
      .then(setAgents)
      .catch(() => {});
  };
  useEffect(load, []);

  useEffect(() => {
    api()
      ?.agents.availableTools()
      .then(setTools)
      .catch(() => {});
    // Model options come from the ACTIVE provider (where sub-agents run):
    // show the label, fall back to the API model name when unlabelled.
    void api()
      ?.providers.getActive()
      .then((p) => {
        const list = (p?.models ?? [])
          .filter((m: { hidden?: boolean }) => !m.hidden)
          .map((m: { name: string; label?: string }) => ({
            name: m.name,
            label: m.label?.trim() || m.name,
          }));
        setModels(list);
      })
      .catch(() => {});
  }, []);

  const taken = useMemo(() => {
    const s = new Set<string>();
    for (const a of agents) {
      s.add(a.type.toLowerCase());
      s.add(a.slug.toLowerCase());
    }
    return s;
  }, [agents]);

  const remove = async (slug: string): Promise<void> => {
    await api()?.agents.deleteBySlug(slug);
    load();
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Agents</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Sub-agent types the main agent can delegate to via the Task tool.
            Each has its own system prompt, tools and model. Built-ins are
            read-only; your agents are saved to{" "}
            <span className="font-mono">agents/&lt;name&gt;.md</span>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModal("new")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
        >
          <Plus className="size-4" /> New
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        {agents.map((a) => (
          <div
            key={`${a.source}-${a.slug}`}
            className="group grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
          >
            <Bot
              className={cn(
                "size-4",
                a.editable ? "text-violet-500" : "text-muted-foreground",
              )}
            />
            <button
              type="button"
              disabled={!a.editable}
              onClick={() => a.editable && setEditSlug(a.slug)}
              className="min-w-0 text-left disabled:cursor-default"
              title={a.editable ? "Edit agent" : "Built-in agent (read-only)"}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "truncate text-sm font-medium",
                    a.editable && "hover:underline",
                  )}
                >
                  {a.type}
                </span>
                {a.tools && a.tools.length > 0 && (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {a.tools.length} tools
                  </span>
                )}
                {a.model && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {a.model}
                  </span>
                )}
              </div>
              {a.description && (
                <div className="truncate text-xs text-muted-foreground">
                  {a.description}
                </div>
              )}
            </button>
            <span className="text-xs text-muted-foreground">
              {a.source === "built-in" ? "built-in" : "you"}
            </span>
            {a.editable ? (
              <button
                type="button"
                onClick={() => void remove(a.slug)}
                title="Delete agent"
                className="rounded-md p-1 text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
              >
                <Trash2 className="size-4" />
              </button>
            ) : (
              <Lock className="size-3.5 text-muted-foreground/50" />
            )}
          </div>
        ))}
      </div>

      {modal === "new" && (
        <NewAgentModal
          tools={tools}
          models={models}
          taken={taken}
          onClose={() => setModal("none")}
          onCreated={load}
        />
      )}
      {editSlug && (
        <EditAgentModal
          slug={editSlug}
          onClose={() => setEditSlug(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
