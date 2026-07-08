import { useEffect, useRef, useState } from "react";
import {
  ClipboardList,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI, SkillInfo } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function fmtDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "2-digit",
      month: "numeric",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

// ─── Write-instructions modal ─────────────────────────────────────────────

function WriteSkillModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    if (!name.trim()) {
      setError("Skill name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api()?.skills.create({ name, description, instructions });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create skill");
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Write skill instructions" onClose={onClose}>
      <label className="block text-sm font-medium">Skill name</label>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="weekly-status-report"
        className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground/20"
      />

      <label className="mt-4 block text-sm font-medium">Description</label>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What the skill does and when to use it. This is what the model reads to decide whether to invoke it."
        rows={2}
        className="mt-1.5 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground/20"
      />

      <label className="mt-4 block text-sm font-medium">Instructions</label>
      <textarea
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder="The instructions the model follows when this skill is invoked…"
        rows={7}
        className="mt-1.5 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:ring-1 focus:ring-foreground/20"
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
          onClick={create}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Create
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Upload modal ─────────────────────────────────────────────────────────

function UploadSkillModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const content = await file.text();
      await api()?.skills.importFile({ filename: file.name, content });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import skill");
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Upload skill" onClose={onClose}>
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) void handleFile(f);
        }}
        className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-10 text-center transition-colors hover:bg-muted/50 disabled:opacity-50"
      >
        <Upload className="size-6 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          Drag and drop or click to upload
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".md,.skill,.markdown,text/markdown"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />

      <div className="mt-4 text-xs text-muted-foreground">
        <div className="mb-1 font-medium text-foreground">File requirements</div>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            A <span className="font-mono">.md</span> file with the skill name and
            description in YAML frontmatter.
          </li>
          <li>The rest of the file is the skill&apos;s instructions.</li>
        </ul>
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
    </ModalShell>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-xl"
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

// ─── Main panel ────────────────────────────────────────────────────────────

export function SkillsSettings(): JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [modal, setModal] = useState<"none" | "write" | "upload">("none");

  const load = (): void => {
    api()
      ?.skills.list()
      .then((s) => setSkills(s))
      .catch(() => {});
  };
  useEffect(load, []);

  const remove = async (slug: string): Promise<void> => {
    await api()?.skills.deleteBySlug(slug);
    load();
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Skills</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Reusable prompts the agent can invoke by name. Stored in your data
            folder and available immediately.
          </p>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setAddOpen((o) => !o)}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
          >
            <Plus className="size-4" /> Add
          </button>
          {addOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setAddOpen(false)}
              />
              <div className="absolute right-0 z-20 mt-1 w-52 rounded-xl border border-border bg-card p-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    setAddOpen(false);
                    setModal("write");
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                >
                  <ClipboardList className="size-4 text-muted-foreground" />
                  Write skill instructions
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddOpen(false);
                    setModal("upload");
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                >
                  <Upload className="size-4 text-muted-foreground" />
                  Upload a skill
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {skills.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          No skills yet. Use <span className="font-medium">Add</span> to create
          one.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>Skill</span>
            <span>Last updated</span>
            <span>Author</span>
            <span />
          </div>
          {skills.map((s) => (
            <div
              key={s.slug}
              className="group grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{s.name}</div>
                {s.description && (
                  <div className="truncate text-xs text-muted-foreground">
                    {s.description}
                  </div>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {fmtDate(s.updatedAt)}
              </span>
              <span className="text-xs text-muted-foreground">{s.author}</span>
              <button
                type="button"
                onClick={() => remove(s.slug)}
                title="Delete skill"
                className={cn(
                  "rounded-md p-1 text-muted-foreground opacity-0 transition-all",
                  "hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100",
                )}
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {modal === "write" && (
        <WriteSkillModal onClose={() => setModal("none")} onCreated={load} />
      )}
      {modal === "upload" && (
        <UploadSkillModal onClose={() => setModal("none")} onCreated={load} />
      )}
    </div>
  );
}
