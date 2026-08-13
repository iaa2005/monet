/**
 * Toolchains in the sandbox image.
 *
 * The container runs with --rm, so a chat cannot install gcc for itself: apt's
 * work dies with the container. What lasts is the IMAGE, and this is where the
 * user says what goes into it — ticked toolchains, plus any Containerfile lines
 * of their own. The recipe is hashed into a tag (see image-extras.ts), so going
 * back to a set you had before is instant, and a line that does not build
 * leaves every chat running on the base image.
 *
 * Shown whatever engine is selected. Podman is the only engine with an image,
 * but hiding this behind the picker would mean nobody discovers it exists
 * before choosing — and the choice reads differently once you know Rust and a
 * C compiler are one tick away.
 */

import { useEffect, useState, type ComponentType } from "react";
import {
  Binary,
  FileText,
  Film,
  Database,
  FolderGit2,
  Globe,
  SquareTerminal,
  Wrench,
  Loader2,
  Plus,
  type LucideIcon,
} from "lucide-react";
import {
  CppIcon,
  GoIcon,
  JavaIcon,
  RustIcon,
} from "@/components/icons";
import { PickCard } from "@/components/settings/PickCard";
import { SectionHeader } from "@/components/settings/SectionTitle";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

interface Preset {
  id: string;
  label: string;
  category: string;
  size: string;
  provides: string;
}

/** One glyph per shelf — the row is findable by eye before it is read. */
const SHELF_ICON: Record<string, LucideIcon> = {
  Languages: Binary,
  Web: Globe,
  Documents: FileText,
  Media: Film,
  Data: Database,
  Tools: Wrench,
};

/**
 * Icons for the entries that HAVE a likeness — a gopher, a coffee cup, a gear
 * with an R. Everything else falls back to its shelf's glyph, which is the
 * honest answer for "PDF tools" and "Shell utilities": they are a category,
 * not a thing.
 */
const ENTRY_ICON: Record<
  string,
  ComponentType<{ className?: string }>
> = {
  cpp: CppIcon,
  rust: RustIcon,
  go: GoIcon,
  jdk: JavaIcon,
  git: FolderGit2,
  shell: SquareTerminal,
};

export function SandboxImageSettings({
  engine,
}: {
  /** The selected engine — only "docker" (Podman) actually has an image. */
  engine: string;
}): JSX.Element {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [extra, setExtra] = useState("");
  const [building, setBuilding] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  /** Set once the recipe differs from what was last built here. */
  const [dirty, setDirty] = useState(false);
  /** The hand-written box is opened by a button, not always on screen. */
  const [manual, setManual] = useState(false);

  /**
   * The list, in shelves.
   *
   * Grouped from the presets rather than from the category list, so a shelf
   * with nothing on it does not appear as an empty heading, and a preset added
   * in a later version shows up without touching this file.
   */
  const shelves: [string, Preset[]][] = [];
  for (const p of presets) {
    const shelf = shelves.find(([name]) => name === p.category);
    if (shelf) shelf[1].push(p);
    else shelves.push([p.category, [p]]);
  }

  useEffect(() => {
    api()
      ?.sandbox.image.get()
      .then((r) => {
        setPresets(r.presets);
        setChosen(r.extras.presets);
        setExtra(r.extras.extra);
      })
      .catch(() => {});
  }, []);

  // Writes the recipe; the build itself is explicit. Saving on every tick keeps
  // the setting truthful even if the user closes Settings without rebuilding —
  // the next sandbox run picks it up lazily.
  const save = (next: { presets?: string[]; extra?: string }): void => {
    setDirty(true);
    setLog(null);
    void api()?.sandbox.image.set(next);
  };

  const toggle = (id: string): void => {
    const next = chosen.includes(id)
      ? chosen.filter((x) => x !== id)
      : [...chosen, id];
    setChosen(next);
    save({ presets: next });
  };

  const rebuild = async (): Promise<void> => {
    setBuilding(true);
    setLog(null);
    try {
      const r = await api()?.sandbox.image.rebuild();
      setDirty(false);
      setLog(
        r?.error
          ? `Failed: ${r.error}`
          : (r?.log ?? "").trim() || "Nothing to build — the image is up to date.",
      );
    } finally {
      setBuilding(false);
    }
  };

  const nothingChosen = chosen.length === 0 && !extra.trim();

  return (
    <section className="space-y-3">
      <SectionHeader
        title="Tools in the image"
        description="Pick what the sandbox should come with. Each one is built into the shared image once and is then there for every chat — a chat cannot install these for itself, because its container is discarded the moment a command finishes. Python packages are not on this list: pip installs those in seconds, into a layer every chat already shares."
      />

      {engine !== "docker" && (
        <div className="rounded-xl border border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
          These apply to the Podman container engine. Pick it above and they are
          built on the next run.
        </div>
      )}

      {shelves.map(([shelf, items]) => (
        <div key={shelf} className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {shelf}
          </div>
          {items.map((p) => (
            <PickCard
              key={p.id}
              icon={ENTRY_ICON[p.id] ?? SHELF_ICON[p.category]}
              title={p.label}
              badge={
                <span className="rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground dark:bg-white/[0.08]">
                  {p.size}
                </span>
              }
              description={p.provides}
              selected={chosen.includes(p.id)}
              onClick={() => toggle(p.id)}
            />
          ))}
        </div>
      ))}

      {/* Hand-written lines live behind a button: they are the exception, and
          an always-open code box makes the list above look like it is not
          enough on its own. */}
      {!manual && !extra.trim() ? (
        <button
          type="button"
          onClick={() => setManual(true)}
          className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <Plus className="size-3.5" />
          Add manually
        </button>
      ) : (
        <div className="space-y-1.5">
          <div className="text-[12px] font-medium">Containerfile lines</div>
          <textarea
            value={extra}
            onChange={(e) => {
              setExtra(e.target.value);
              setDirty(true);
              setLog(null);
            }}
            onBlur={() => save({ extra })}
            spellCheck={false}
            rows={4}
            autoFocus={manual}
            placeholder={"RUN apt-get update \\\n && apt-get install -y --no-install-recommends cowsay"}
            className="w-full resize-y rounded-xl border border-border bg-transparent px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus:border-foreground/30"
          />
          <div className="text-[11px] text-muted-foreground">
            Added after everything ticked above. No FROM line — this is a layer
            on the sandbox image. If it does not build, chats keep running
            without it and the log below says why.
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void rebuild()}
          disabled={building || nothingChosen}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {building && <Loader2 className="size-3 animate-spin" />}
          {building ? "Building…" : "Build now"}
        </button>
        {dirty && !building && !nothingChosen && (
          <span className="text-[11px] text-muted-foreground">
            Not built yet — this happens on the next sandbox run, or now.
          </span>
        )}
      </div>

      {log && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {log}
        </pre>
      )}
    </section>
  );
}
