/**
 * Settings → Memory — mirrors Claude.ai's Memory page: two toggles, the
 * memory-file table grouped You / Topics / Areas, an editor modal, and a
 * "tell Claude something to remember" box at the bottom.
 */
import { useEffect, useState } from "react";
import { ArrowUp, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI, MemoryFileInfo } from "@/types/electron";

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

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-10 shrink-0 rounded-full transition-colors",
        checked ? "bg-primary" : "bg-black/[0.15] dark:bg-white/[0.2]",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
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
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">
            Edit memory <span className="font-mono text-xs text-muted-foreground">{id}</span>
          </h3>
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

export function MemorySettings(): JSX.Element {
  const [config, setConfig] = useState({ searchChats: true, generateMemory: true });
  const [files, setFiles] = useState<MemoryFileInfo[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = (): void => {
    void api()?.memory.list().then(setFiles);
    void api()?.memory.getConfig().then(setConfig);
  };
  useEffect(load, []);

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
      <h3 className="text-base font-semibold">Memory</h3>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-medium">Search and reference chats</div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Allow the agent to search for relevant details in past chats
            (adds the SearchPastChats tool).
          </p>
        </div>
        <Toggle
          checked={config.searchChats}
          onChange={(v) => void toggle("searchChats", v)}
        />
      </div>

      <div className="mt-5 flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-medium">Generate memory from chats</div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            After a conversation, quietly distil durable facts (who you are,
            projects, workflows) into the memory files below.
          </p>
        </div>
        <Toggle
          checked={config.generateMemory}
          onChange={(v) => void toggle("generateMemory", v)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
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
          <div className="mt-8 rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            No memory yet. It builds up as you chat — or tell it something below.
          </div>
        )}
      </div>

      {notice && <p className="mb-1 text-xs text-muted-foreground">{notice}</p>}
      <div className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2">
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
          className="flex size-7 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90 disabled:opacity-30"
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
