import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ClipboardList,
  Code,
  Eye,
  FileText,
  Folder,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownViewer } from "@/components/chat/MarkdownViewer";
import { CodeBlock } from "@/components/chat/CodeBlock";
import { DirectoryButton } from "@/components/directory/DirectoryModal";
import type { ElectronAPI, SkillInfo } from "@/types/electron";
import {
  SectionHeader,
  SectionTitle,
} from "@/components/settings/SectionTitle";

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

  /** Dropped item: a skill FOLDER imports whole; a .md file imports as
   * before. Reading a dropped directory with file.text() throws a DOM
   * NotFoundError — never do that, route through the path first. */
  const handleDropped = async (file: File): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const path = api()?.getPathForFile?.(file);
      if (path) {
        const r = await api()?.skills.importFolder(path);
        if (r?.ok) {
          onCreated();
          onClose();
          return;
        }
        // A real folder with a problem (e.g. no SKILL.md) — report it.
        if (r?.error && r.error !== "Not a folder") {
          setError(r.error);
          setBusy(false);
          return;
        }
      }
      if (!/\.(md|markdown|skill)$/i.test(file.name)) {
        setError("Drop a skill folder (containing SKILL.md) or a .md file.");
        setBusy(false);
        return;
      }
      const content = await file.text();
      await api()?.skills.importFile({ filename: file.name, content });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import skill");
      setBusy(false);
    }
  };

  const pickFolder = async (): Promise<void> => {
    setError(null);
    const dir = await api()?.files.pickDirectory();
    if (!dir) return;
    setBusy(true);
    try {
      const r = await api()?.skills.importFolder(dir);
      if (r?.ok) {
        onCreated();
        onClose();
      } else {
        setError(r?.error ?? "Failed to import folder");
        setBusy(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import folder");
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
          if (f) void handleDropped(f);
        }}
        className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-10 text-center transition-colors hover:bg-muted/50 disabled:opacity-50"
      >
        <Upload className="size-6 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          Drag & drop a skill folder or a .md file — or click to pick a file
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".md,.skill,.markdown,text/markdown"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleDropped(f);
        }}
      />

      <button
        type="button"
        disabled={busy}
        onClick={() => void pickFolder()}
        className="mt-2 w-full rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] disabled:opacity-50 dark:hover:bg-white/[0.05]"
      >
        Choose a skill folder…
      </button>

      <div className="mt-4 text-xs text-muted-foreground">
        <div className="mb-1 font-medium text-foreground">Requirements</div>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            A skill <span className="font-medium">folder</span> must contain{" "}
            <span className="font-mono">SKILL.md</span>; the folder name
            becomes the skill (name collisions get a numeric suffix).
          </li>
          <li>
            A lone <span className="font-mono">.md</span> file needs the skill
            name and description in YAML frontmatter; the rest is the
            instructions.
          </li>
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
        className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <SectionTitle>{title}</SectionTitle>
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

// ─── Skill detail (file browser + viewer/editor) ──────────────────────────

function langFromPath(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "markdown",
    markdown: "markdown",
    py: "python",
    js: "javascript",
    ts: "typescript",
    tsx: "tsx",
    jsx: "jsx",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    sh: "bash",
    ps1: "powershell",
    html: "html",
    css: "css",
    svg: "xml",
    xml: "xml",
  };
  return map[ext] ?? "text";
}

function SkillDetailModal({
  skill,
  onClose,
  onChanged,
}: {
  skill: SkillInfo;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [files, setFiles] = useState<{ path: string; isDir: boolean }[]>([]);
  const [current, setCurrent] = useState("SKILL.md");
  const [fileMenu, setFileMenu] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"preview" | "code">("preview");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api()
      ?.skills.files(skill.slug)
      .then(setFiles)
      .catch(() => {});
  }, [skill.slug]);

  useEffect(() => {
    setContent(null);
    setError(null);
    setEditing(false);
    api()
      ?.skills.readFile(skill.slug, current)
      .then((r) => {
        if (r.ok) setContent(r.content ?? "");
        else setError(r.error ?? "Failed to read file");
      })
      .catch((e) => setError(String(e)));
  }, [skill.slug, current]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api()?.skills.writeFile(skill.slug, current, draft);
      if (r?.ok) {
        setContent(draft);
        setEditing(false);
        onChanged();
      } else {
        setError(r?.error ?? "Failed to save");
      }
    } finally {
      setBusy(false);
    }
  };

  const fileCount = files.filter((f) => !f.isDir).length;
  const isMd = /\.(md|markdown)$/i.test(current);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[82vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 pb-2 pt-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <SectionTitle className="truncate">{skill.name}</SectionTitle>
              <span className="shrink-0 text-xs text-muted-foreground">
                by {skill.author}
              </span>
            </div>
            {skill.description && (
              <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">
                {skill.description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Toolbar: file picker + view toggles + edit */}
        <div className="flex items-center gap-2 border-b border-border px-5 pb-2.5">
          <div className="relative">
            <button
              type="button"
              onClick={() => setFileMenu((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px] font-medium transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <FileText className="size-3.5 text-muted-foreground" />
              <span className="max-w-[24ch] truncate">{current}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
            {fileMenu && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setFileMenu(false)}
                />
                <div className="absolute left-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-lg">
                  {files.map((f) => {
                    const depth = f.path.split("/").length - 1;
                    const label = f.path.split("/").pop() ?? f.path;
                    return f.isDir ? (
                      <div
                        key={f.path}
                        style={{ paddingLeft: 8 + depth * 14 }}
                        className="flex items-center gap-1.5 py-1 text-[12px] text-muted-foreground"
                      >
                        <Folder className="size-3.5" />
                        {label}
                      </div>
                    ) : (
                      <button
                        key={f.path}
                        type="button"
                        onClick={() => {
                          setCurrent(f.path);
                          setFileMenu(false);
                        }}
                        style={{ paddingLeft: 8 + depth * 14 }}
                        className={cn(
                          "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]",
                          f.path === current && "bg-black/[0.05] dark:bg-white/[0.06]",
                        )}
                      >
                        <FileText className="size-3.5 text-muted-foreground" />
                        <span className="truncate">{label}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            {fileCount} files
          </span>
          <span className="flex-1" />
          {!editing && content != null && (
            <>
              <div className="flex gap-0.5 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.05]">
                <button
                  type="button"
                  title="Preview"
                  onClick={() => setView("preview")}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-md transition-colors",
                    view === "preview"
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Eye className="size-3.5" />
                </button>
                <button
                  type="button"
                  title="Source"
                  onClick={() => setView("code")}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-md transition-colors",
                    view === "code"
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Code className="size-3.5" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  setDraft(content ?? "");
                  setEditing(true);
                }}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[13px] font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
              >
                <Pencil className="size-3.5" />
                Edit
              </button>
            </>
          )}
          {editing && (
            <>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-lg px-2.5 py-1 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void save()}
                className="rounded-lg bg-foreground px-3 py-1 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {content == null && !error && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="h-full min-h-[50vh] w-full resize-none rounded-lg border border-border bg-background p-3 font-mono text-xs leading-relaxed outline-none focus:ring-1 focus:ring-foreground/20"
            />
          ) : content != null && view === "preview" && isMd ? (
            <MarkdownViewer content={content} />
          ) : content != null ? (
            <CodeBlock
              code={content}
              language={langFromPath(current)}
              className="my-0"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Main panel ────────────────────────────────────────────────────────────

export function SkillsSettings(): JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [modal, setModal] = useState<"none" | "write" | "upload">("none");
  const [detailSlug, setDetailSlug] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);

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

  // Drop a skill FOLDER anywhere on the panel: the folder name becomes the
  // skill (collisions get -2/-3…). Lone .md files still import as before.
  const handleDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    setDropError(null);
    for (const f of Array.from(e.dataTransfer.files)) {
      try {
        const path = api()?.getPathForFile?.(f);
        if (path) {
          const r = await api()?.skills.importFolder(path);
          if (r?.ok) continue;
          if (/\.(md|markdown|skill)$/i.test(f.name)) {
            await api()?.skills.importFile({
              filename: f.name,
              content: await f.text(),
            });
            continue;
          }
          setDropError(r?.error ?? "Import failed");
        }
      } catch (err) {
        setDropError(err instanceof Error ? err.message : "Import failed");
      }
    }
    load();
  };

  return (
    <div onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <SectionHeader
        title="Skills"
        description="Reusable prompts the agent can invoke by name. Click a skill to browse and edit its files; drop a skill folder here to import it."
      />
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

      <div className="mb-3">
        <DirectoryButton
          section="skills"
          title="Browse the Directory"
          subtitle="Install skills from monet-directory or any GitHub repo whose folders hold a SKILL.md"
          onChanged={load}
        />
      </div>

      {skills.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          No skills yet. Browse the Directory, or use{" "}
          <span className="font-medium">Add</span> to write one yourself.
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
              <button
                type="button"
                onClick={() => setDetailSlug(s.slug)}
                className="min-w-0 text-left"
                title="Browse and edit skill files"
              >
                <div className="truncate text-sm font-medium hover:underline">
                  {s.name}
                </div>
                {s.description && (
                  <div className="truncate text-xs text-muted-foreground">
                    {s.description}
                  </div>
                )}
              </button>
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

      {dropError && (
        <p className="mt-3 text-xs text-destructive">{dropError}</p>
      )}

      {modal === "write" && (
        <WriteSkillModal onClose={() => setModal("none")} onCreated={load} />
      )}
      {modal === "upload" && (
        <UploadSkillModal onClose={() => setModal("none")} onCreated={load} />
      )}
      {detailSlug && (
        <SkillDetailModal
          skill={skills.find((s) => s.slug === detailSlug)!}
          onClose={() => setDetailSlug(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
