import { useEffect, useState } from "react";
import { Bot, Lock, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentSummary, ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function ModalShell({
  title,
  onClose,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={cn(
          "w-full rounded-2xl border border-border bg-card p-5 shadow-xl",
          wide ? "max-w-2xl" : "max-w-lg",
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
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tools, setTools] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    if (!name.trim()) return setError("Agent name is required");
    if (!prompt.trim()) return setError("System prompt is required");
    setBusy(true);
    setError(null);
    try {
      await api()?.agents.create({
        name,
        description,
        prompt,
        tools: tools
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        model: model.trim() || undefined,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
      setBusy(false);
    }
  };

  return (
    <ModalShell title="New agent" onClose={onClose}>
      <label className="block text-sm font-medium">Name (agent type)</label>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="code-reviewer"
        className={INPUT}
      />

      <label className="mt-4 block text-sm font-medium">Description</label>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="When the main agent should delegate to this type. The model reads this to route subagent_type."
        rows={2}
        className={cn(INPUT, "resize-none")}
      />

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium">
            Tools <span className="text-muted-foreground">(optional)</span>
          </label>
          <input
            value={tools}
            onChange={(e) => setTools(e.target.value)}
            placeholder="Read, Grep, Glob"
            className={INPUT}
          />
        </div>
        <div>
          <label className="block text-sm font-medium">
            Model <span className="text-muted-foreground">(optional)</span>
          </label>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="inherit"
            className={INPUT}
          />
        </div>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Leave Tools empty for the full toolset. An allow-list restricts the
        sub-agent to exactly those tools (it never gets Task).
      </p>

      <label className="mt-4 block text-sm font-medium">System prompt</label>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="You are a … agent. Given the task, …"
        rows={7}
        className={cn(INPUT, "resize-none font-mono text-xs leading-relaxed")}
      />

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
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
    <ModalShell title={`Edit ${slug}.md`} onClose={onClose} wide>
      {error && <p className="mb-3 text-xs text-destructive">{error}</p>}
      {draft == null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="h-[52vh] w-full resize-none rounded-lg border border-border bg-background p-3 font-mono text-xs leading-relaxed outline-none focus:ring-1 focus:ring-foreground/20"
        />
      )}
      <div className="mt-4 flex justify-end gap-2">
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
  const [modal, setModal] = useState<"none" | "new">("none");
  const [editSlug, setEditSlug] = useState<string | null>(null);

  const load = (): void => {
    api()
      ?.agents.list()
      .then(setAgents)
      .catch(() => {});
  };
  useEffect(load, []);

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
        <NewAgentModal onClose={() => setModal("none")} onCreated={load} />
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
