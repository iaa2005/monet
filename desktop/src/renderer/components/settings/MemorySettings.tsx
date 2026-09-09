/**
 * Settings → Memory — everything the app remembers, and everything that
 * decides whether it does.
 *
 * One page, three levels, in the order a person asks about them: is memory
 * used at all, what tops it up and what that costs, and what is actually in
 * there. The switches used to be six, spread over this page and Advanced,
 * and two of them crossed — see the note on MemoryConfig in
 * main/memory/store.ts for the install where that showed "enabled" on one
 * page and did nothing at night.
 */
import { useEffect, useState } from "react";
import {
  ArrowUp,
  BookMarked,
  ChevronDown,
  ChevronRight,
  GraduationCap,
  MoonStar,
  NotebookPen,
  Search,
  Trash2,
  Undo2,
  X,
} from "@/components/icons/hg";
import { Switch } from "@/components/ui/switch";
import type {
  ElectronAPI,
  MemoryConfig,
  MemoryFileInfo,
  ProjectLessons,
} from "@/types/electron";
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
}

/** One line of status: when it last ran, what it did, what's queued. */
function describeConsolidation(s: ConsolidationState | null): string {
  if (!s) return "";
  if (!s.lastConsolidatedAt)
    return s.lastError ? `Last attempt failed: ${s.lastError}` : "Never run.";
  const hours = (Date.now() - s.lastConsolidatedAt) / 3_600_000;
  const when =
    hours < 1
      ? "less than an hour ago"
      : hours < 24
        ? `${Math.round(hours)}h ago`
        : `${Math.round(hours / 24)}d ago`;
  const tail = s.lastError ? ` Last attempt failed: ${s.lastError}` : "";
  return `Last run ${when}${s.lastSummary ? ` — ${s.lastSummary}` : ""}.${tail}`;
}

export function MemorySettings(): JSX.Element {
  const [config, setConfig] = useState<MemoryConfig>({
    useInChats: true,
    nightly: true,
    runNotes: true,
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

  const toggle = async (key: keyof MemoryConfig, v: boolean): Promise<void> => {
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
      {/* 1 ─ Is memory used at all. One switch, because there is one answer:
             the files in the prompt, this project's lessons, the tool that
             searches past chats and the tool that writes a new memory all
             stand or fall together. Two of these used to be separate and
             they disagreed. */}
      <SettingCard
        icon={BookMarked}
        title="Use memory in chats"
        description="What is saved below travels with every conversation, along with this project's lessons. The agent can also search past chats and save a new memory as it works. Turning this off keeps everything — it just stops being read or written."
        on={config.useInChats}
        control={
          <Switch
            checked={config.useInChats}
            onChange={(v) => void toggle("useInChats", v)}
          />
        }
      />

      <SectionTitle className="mt-5">How it fills up</SectionTitle>

      {/* 2 ─ What tops it up, each with its price said in words. Two of the
             three cost nothing at all, which is the point of listing them
             beside the one that does. */}
      <SettingCard
        icon={Search}
        title="The agent saves what it learns"
        on={config.useInChats}
        description="When you state a preference, correct it, or tell it something about your work, it writes that down as it happens. No extra model call — it is part of the reply it was already writing."
      />

      <SettingCard
        icon={ArrowUp}
        title="You tell it something"
        on
        description="The box at the bottom of this page. Saved word for word, immediately, with no model in the way."
      />

      <SettingCard
        icon={MoonStar}
        title="Tidied up overnight"
        description="Around 3–5am when the computer is on, and it catches up if it was off. Reads every memory file at once, merges what was added during the day, moves a fact to the topic it belongs in, drops what has been contradicted, and rewrites the index. The same pass distils each project's lessons. One call to the background model a night; nothing else here costs one."
        on={config.nightly}
        control={
          <Switch
            checked={config.nightly}
            onChange={(v) => void toggle("nightly", v)}
          />
        }
      >
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void consolidateNow()}
            disabled={consolidating}
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {consolidating ? "Consolidating…" : "Tidy up now"}
          </button>
          <button
            type="button"
            onClick={() => void dreamNow()}
            disabled={dreaming}
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {dreaming ? "Learning…" : "Learn from failures now"}
          </button>
          {/* Both buttons work with the switch off — they are a request, not
              a schedule. Saying so is the difference between a button that
              looks broken and one that is a choice. */}
          {!config.nightly && (
            <span className="text-xs text-muted-foreground">
              Automatic runs are off; these still work.
            </span>
          )}
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          {consolidateMsg ?? describeConsolidation(consState)}
        </div>
        {dreamMsg && (
          <div className="mt-1 text-xs text-muted-foreground">{dreamMsg}</div>
        )}
      </SettingCard>

      {/* 3 ─ Memory of a PROJECT rather than of the user. It lived under
             Advanced → "Between runs", where nothing else was about memory
             and nobody would look for it. */}
      <SettingCard
        icon={NotebookPen}
        title="Notes between runs"
        description="A goal that finishes writes what it did; one that blocks writes what stopped it. The next run in that same folder starts with those lines, so it neither redoes the work nor walks into the same wall. Costs nothing."
        on={config.runNotes}
        control={
          <Switch
            checked={config.runNotes}
            onChange={(v) => void toggle("runNotes", v)}
          />
        }
      />

      <SectionTitle className="mt-5">What it remembers</SectionTitle>

      {/* The per-project half of what the night pass produces. The switch and
          the button for it are up with the other one, where the cost is
          stated; this is the contents, and the undo. */}
      <SettingCard
        icon={GraduationCap}
        title="Project lessons"
        on={config.useInChats}
        description="What went wrong in each folder — failed commands, chats that stopped on an error, goals that ran out of budget — distilled into lessons that ride only into chats working there. A bad night is one click to undo."
      >
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
              <SectionTitle>{label}</SectionTitle>
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
