/**
 * Settings → Memory — mirrors Claude.ai's Memory page: two toggles, the
 * memory-file table grouped You / Topics / Areas, an editor modal, and a
 * "tell Claude something to remember" box at the bottom.
 */
import { useEffect, useState } from "react";
import {
  ArrowUp,
  BookMarked,
  ChevronDown,
  ChevronRight,
  GraduationCap,
  MoonStar,
  Search,
  Timer,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { ElectronAPI, MemoryFileInfo, ProjectLessons } from "@/types/electron";
import { Select } from "@/components/ui/select";
import { SettingCard } from "./SettingCard";
import { SectionTitle } from "@/components/settings/SectionTitle";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function agoOf(ms: number): string {
  const d = Date.now() - ms;
  const h = Math.round(d / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h} hour${h > 1 ? "s" : ""} ago`;
  const days = Math.round(h / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

function EditMemoryModal({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api()
      ?.memory.read(id)
      .then((r) => {
        if (r.ok) {
          setName(r.name ?? "");
          setSummary(r.summary ?? "");
          setBody(r.body ?? "");
        } else setError(r.error ?? "Failed to read");
      });
  }, [id]);

  const save = async (): Promise<void> => {
    if (body == null) return;
    setBusy(true);
    const r = await api()?.memory.write(id, { name, summary, body });
    setBusy(false);
    if (r?.ok) {
      onChanged();
      onClose();
    } else setError(r?.error ?? "Failed to save");
  };

  const INPUT =
    "mt-1 w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-foreground/20";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <SectionTitle>
            Edit memory <span className="font-mono text-xs text-muted-foreground">{id}</span>
          </SectionTitle>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <X className="size-4" />
          </button>
        </div>
        {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
        <label className="text-xs font-medium">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
        <label className="mt-3 text-xs font-medium">Summary</label>
        <input value={summary} onChange={(e) => setSummary(e.target.value)} className={INPUT} />
        <label className="mt-3 text-xs font-medium">Content</label>
        {body == null ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            className="mt-1 h-[38vh] w-full resize-none rounded-lg border border-border bg-background p-3 font-mono text-xs leading-relaxed outline-none focus:ring-1 focus:ring-foreground/20"
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
            disabled={busy || body == null}
            onClick={() => void save()}
            className="rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const SECTIONS: { key: MemoryFileInfo["section"]; label: string }[] = [
  { key: "you", label: "You" },
  { key: "topics", label: "Topics" },
  { key: "areas", label: "Areas" },
];

interface ConsolidationState {
  lastConsolidatedAt: number;
  lastSummary: string;
  lastError: string | null;
  runs: number;
  pending: number;
}

/** One line of status: when it last ran, what it did, what's queued. */
function describeConsolidation(s: ConsolidationState | null): string {
  if (!s) return "";
  const queued = s.pending > 0 ? `${s.pending} note${s.pending === 1 ? "" : "s"} waiting` : "nothing waiting";
  if (!s.lastConsolidatedAt)
    return s.lastError ? `Last attempt failed: ${s.lastError}` : `Never run — ${queued}.`;
  const hours = (Date.now() - s.lastConsolidatedAt) / 3_600_000;
  const when =
    hours < 1
      ? "less than an hour ago"
      : hours < 24
        ? `${Math.round(hours)}h ago`
        : `${Math.round(hours / 24)}d ago`;
  const tail = s.lastError ? ` Last attempt failed: ${s.lastError}` : "";
  return `Last run ${when}${s.lastSummary ? ` — ${s.lastSummary}` : ""} · ${queued}.${tail}`;
}

export function MemorySettings(): JSX.Element {
  const [config, setConfig] = useState({
    searchChats: true,
    generateMemory: true,
    extractEveryMinutes: 3,
  });
  const [files, setFiles] = useState<MemoryFileInfo[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [consState, setConsState] = useState<ConsolidationState | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  const [consolidateMsg, setConsolidateMsg] = useState<string | null>(null);
  const [lessons, setLessons] = useState<ProjectLessons[]>([]);
  const [openLesson, setOpenLesson] = useState<string | null>(null);
  const [dreaming, setDreaming] = useState(false);
  const [dreamMsg, setDreamMsg] = useState<string | null>(null);

  const load = (): void => {
    void api()?.memory.list().then(setFiles);
    void api()?.memory.getConfig().then(setConfig);
    void api()?.memory.consolidationState().then(setConsState).catch(() => {});
    void api()?.memory.lessonsList().then(setLessons).catch(() => {});
  };
  useEffect(load, []);

  const dreamNow = async (): Promise<void> => {
    if (dreaming) return;
    setDreaming(true);
    setDreamMsg(null);
    try {
      const r = await api()?.memory.lessonsDream();
      if (r?.ran)
        setDreamMsg(
          r.touched && r.touched.length > 0
            ? `Learned in ${r.touched.length} workspace(s) ✓`
            : "Ran — the signals taught nothing new.",
        );
      else if (r?.error) setDreamMsg(`Failed: ${r.error}`);
      else setDreamMsg(r?.reason ? `Skipped — ${r.reason}` : "Nothing to do.");
      load();
    } finally {
      setDreaming(false);
    }
  };

  const consolidateNow = async (): Promise<void> => {
    if (consolidating) return;
    setConsolidating(true);
    setConsolidateMsg(null);
    try {
      const r = await api()?.memory.consolidate();
      if (r?.ran) setConsolidateMsg(r.summary ?? "Consolidated ✓");
      else if (r?.error) setConsolidateMsg(`Failed: ${r.error}`);
      else setConsolidateMsg(r?.reason ? `Skipped — ${r.reason}` : "Nothing to do.");
      load();
    } finally {
      setConsolidating(false);
    }
  };

  const toggle = async (
    key: "searchChats" | "generateMemory",
    v: boolean,
  ): Promise<void> => {
    const next = await api()?.memory.setConfig({ [key]: v });
    if (next) setConfig(next);
  };

  const remove = async (id: string): Promise<void> => {
    await api()?.memory.deleteById(id);
    load();
  };

  const sendNote = async (): Promise<void> => {
    const t = note.trim();
    if (!t || noteBusy) return;
    setNoteBusy(true);
    setNotice(null);
    try {
      const r = await api()?.memory.addNote(t);
      if (r?.ok) {
        setNote("");
        setNotice("Remembered ✓");
        load();
      } else setNotice("Failed to save the note.");
    } finally {
      setNoteBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <SectionTitle>Memory</SectionTitle>

      <div className="mt-4 grid gap-2">
      <SettingCard
        icon={Search}
        title="Search and reference chats"
        description="Allow the agent to search for relevant details in past chats (adds the SearchPastChats tool)."
        on={config.searchChats}
        control={
          <Switch
            checked={config.searchChats}
            onChange={(v) => void toggle("searchChats", v)}
          />
        }
      />

      <SettingCard
        icon={BookMarked}
        title="Generate memory from chats"
        description="After a conversation, quietly note durable facts (who you are, projects, workflows) in a daily log. Overnight those notes are consolidated into the memory files below."
        on={config.generateMemory}
        control={
          <Switch
            checked={config.generateMemory}
            onChange={(v) => void toggle("generateMemory", v)}
          />
        }
      />

      {config.generateMemory && (
        <SettingCard
          icon={Timer}
          title="Memory extraction"
          on
          description="How often a conversation may be read for durable facts. Noting after every message would charge you for a model call you did not ask for."
        >
          <div className="mt-2 flex items-center justify-between gap-4">
            <span className="text-[13px] text-muted-foreground">
              Run extraction at most once per…
            </span>
            <Select
              ariaLabel="Extract every"
              value={String(config.extractEveryMinutes)}
              onChange={(v) =>
                void api()
                  ?.memory.setConfig({ extractEveryMinutes: Number(v) })
                  .then((next) => next && setConfig(next))
              }
              className="py-1.5 text-sm"
              options={[
                { value: "0", label: "Never" },
                ...[1, 3, 10, 30, 60].map((m) => ({
                  value: String(m),
                  label: `${m} min`,
                })),
              ]}
            />
          </div>
          {config.extractEveryMinutes === 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Nothing is noted automatically. Memories you ask for explicitly
              still get saved, and nightly consolidation still tidies them up.
            </p>
          )}
        </SettingCard>
      )}

      <SettingCard
        icon={MoonStar}
        title="Nightly consolidation"
        on
        description="Runs itself around 3–5am when the computer is on (and catches up if it was off). Reads the day's notes with the whole memory in view, merges them in, drops what's stale, and rewrites the index."
        control={
          <button
            type="button"
            onClick={() => void consolidateNow()}
            disabled={consolidating}
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {consolidating ? "Consolidating…" : "Consolidate now"}
          </button>
        }
      >
        <div className="mt-2 text-xs text-muted-foreground">
          {consolidateMsg ?? describeConsolidation(consState)}
        </div>
      </SettingCard>

      <SettingCard
        icon={GraduationCap}
        title="Project lessons"
        on
        description="Overnight, failures from each workspace — failed commands, chats that stopped on errors, goals that ran out of budget — are distilled into lessons injected only when you work in that folder. A bad night is one click to undo."
        control={
          <button
            type="button"
            onClick={() => void dreamNow()}
            disabled={dreaming}
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {dreaming ? "Learning…" : "Learn now"}
          </button>
        }
      >
        {dreamMsg && (
          <div className="mt-2 text-xs text-muted-foreground">{dreamMsg}</div>
        )}
        {lessons.length > 0 && (
          <div className="mt-2">
            {lessons.map((l) => {
              const open = openLesson === l.workspace;
              const name = l.workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
              return (
                <div key={l.workspace} className="border-b border-border py-2 last:border-b-0">
                  <div className="group grid grid-cols-[1rem_10rem_1fr_auto_auto_auto] items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setOpenLesson(open ? null : l.workspace)}
                      className="text-muted-foreground"
                      title={open ? "Collapse" : "What was learned"}
                    >
                      {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </button>
                    <span className="truncate text-sm font-medium" title={l.workspace}>
                      {name}
                    </span>
                    <span className="truncate text-sm text-muted-foreground" title={l.summary}>
                      {l.summary}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      Updated {agoOf(l.updatedAt)}
                    </span>
                    {l.canRollback ? (
                      <button
                        type="button"
                        title="Undo the last learning pass"
                        onClick={() =>
                          void api()?.memory.lessonsRollback(l.workspace).then(load)
                        }
                        className="rounded-md p-1 text-muted-foreground opacity-0 transition-all hover:bg-black/[0.06] hover:text-foreground group-hover:opacity-100 dark:hover:bg-white/[0.08]"
                      >
                        <Undo2 className="size-4" />
                      </button>
                    ) : (
                      <span />
                    )}
                    <button
                      type="button"
                      title="Forget this workspace's lessons"
                      onClick={() =>
                        void api()?.memory.lessonsDelete(l.workspace).then(load)
                      }
                      className="rounded-md p-1 text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                  {open && (
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-black/[0.03] p-3 text-xs leading-relaxed text-muted-foreground dark:bg-white/[0.04]">
                      {l.body}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SettingCard>
      </div>

      <div className="flex-1 pb-4">
        {SECTIONS.map(({ key, label }) => {
          const rows = files.filter((f) => f.section === key);
          if (rows.length === 0) return null;
          return (
            <div key={key} className="mt-7">
              <div className="text-sm font-semibold">{label}</div>
              <div className="mt-1">
                {rows.map((f) => (
                  <div
                    key={f.id}
                    className="group grid grid-cols-[11rem_1fr_auto_auto] items-center gap-3 border-b border-border py-2.5 last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() => setEditId(f.id)}
                      className="truncate text-left text-sm font-medium hover:underline"
                      title="Edit"
                    >
                      {f.name}
                    </button>
                    <span className="truncate text-sm text-muted-foreground">
                      {f.summary}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      Updated {agoOf(f.updatedAt)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void remove(f.id)}
                      title="Delete"
                      className="rounded-md p-1 text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {files.length === 0 && (
          <div className="mt-8 rounded-xl border border-dashed border-border py-23 text-center text-sm text-muted-foreground">
            No memory yet. It builds up as you chat — or tell it something below.
          </div>
        )}
      </div>

      {notice && <p className="mb-1 text-xs text-muted-foreground">{notice}</p>}
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-2 py-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void sendNote();
          }}
          placeholder="My plant is named Gerald"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          disabled={!note.trim() || noteBusy}
          onClick={() => void sendNote()}
          className="flex size-7 items-center justify-center rounded-xl bg-foreground text-background transition-opacity hover:opacity-90 disabled:opacity-30"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>

      {editId && (
        <EditMemoryModal
          id={editId}
          onClose={() => setEditId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
