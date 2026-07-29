/**
 * Directory → Skills.
 *
 * Two kinds of source. A GitHub repo whose folders contain a SKILL.md is
 * enumerated and merged into the grid, each card labelled with its repo.
 *
 * skillsdirectory.com is the other kind: an INDEX of such repos, ~97 000
 * entries, so it cannot be listed — it is searched, and appears as its own
 * group once the query is long enough to mean something.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Globe, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { RegistrySkill, StoreSkill } from "@/types/electron";
import {
  api,
  CardAction,
  Chip,
  DirCard,
  Empty,
  matches,
  Picker,
} from "./shared";

const FILTERS = [
  { label: "All", value: "all" },
  { label: "Installed", value: "installed" },
  { label: "Not installed", value: "available" },
];
const SORTS = [
  { label: "Name", value: "name" },
  { label: "Source", value: "source" },
  { label: "Installed first", value: "installed" },
];

export function SkillsSection({ query }: { query: string }): JSX.Element {
  const [sources, setSources] = useState<string[]>([]);
  const [skills, setSkills] = useState<StoreSkill[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [source, setSource] = useState("all");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("name");
  const [adding, setAdding] = useState(false);
  const [newSource, setNewSource] = useState("");
  const [reloading, setReloading] = useState(false);
  // skillsdirectory.com results for the current query — a separate list, since
  // it is a different kind of source: an index of GitHub repos rather than one
  // repo whose contents we enumerate.
  const [reg, setReg] = useState<RegistrySkill[] | null>(null);
  const [regBusy, setRegBusy] = useState(false);
  const [regError, setRegError] = useState("");

  const load = async (): Promise<void> => {
    setReloading(true);
    try {
      const [srcs, r] = await Promise.all([
        api()?.skillStore.getSources(),
        api()?.skillStore.list(),
      ]);
      setSources(srcs ?? []);
      setSkills(r?.ok ? (r.skills ?? []) : []);
      setErrors(r?.ok ? (r.errors ?? []) : [r?.error ?? "Failed to load"]);
    } finally {
      setReloading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const addSource = async (): Promise<void> => {
    const v = newSource.trim();
    if (!v) return;
    const next = await api()?.skillStore.setSources([...sources, v]);
    setSources(next ?? sources);
    setNewSource("");
    setAdding(false);
    await load();
  };

  const removeSource = async (s: string): Promise<void> => {
    const next = await api()?.skillStore.setSources(
      sources.filter((x) => x !== s),
    );
    setSources(next ?? sources);
    if (source === s) setSource("all");
    await load();
  };

  const install = async (s: StoreSkill): Promise<void> => {
    setBusy(s.source + s.path);
    try {
      const r = await api()?.skillStore.install({
        source: s.source,
        path: s.path,
      });
      if (r?.ok)
        setSkills(
          (prev) =>
            prev?.map((x) =>
              x.source === s.source && x.path === s.path
                ? { ...x, installed: true, slug: r.slug ?? x.slug }
                : x,
            ) ?? null,
        );
      else setErrors([r?.error ?? "Install failed"]);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (s: StoreSkill): Promise<void> => {
    setBusy(s.source + s.path);
    try {
      await api()?.skills.deleteBySlug(s.slug);
      setSkills(
        (prev) =>
          prev?.map((x) =>
            x.source === s.source && x.path === s.path
              ? { ...x, installed: false }
              : x,
          ) ?? null,
      );
    } finally {
      setBusy(null);
    }
  };

  // Debounced: the Directory search box fires on every keystroke, and each one
  // would otherwise be a request to someone else's server.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setReg(null);
      setRegError("");
      return;
    }
    let alive = true;
    setRegBusy(true);
    const timer = setTimeout(() => {
      void api()
        ?.skillStore.searchRegistry({ query: q, limit: 24 })
        .then((r) => {
          if (!alive) return;
          setRegBusy(false);
          if (r?.ok) {
            setReg((r.skills ?? []) as RegistrySkill[]);
            setRegError("");
          } else {
            setReg([]);
            setRegError(r?.error ?? "Could not reach skillsdirectory.com");
          }
        })
        .catch(() => {
          if (!alive) return;
          setRegBusy(false);
          setRegError("Could not reach skillsdirectory.com");
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  /**
   * Install a registry hit.
   *
   * The registry names the REPO but never the folder inside it, so the main
   * process resolves that against the repo's tree. When it cannot tell — two
   * folders with the same name, or none matching — it says so with the
   * candidates rather than installing a guess: the wrong skill is instructions
   * the user never asked for, handed to the model.
   */
  const installFromRegistry = async (
    s: RegistrySkill,
    key: string,
  ): Promise<void> => {
    setBusy(key);
    try {
      const r = await api()?.skillStore.installRegistry({
        repository: s.repository,
        name: s.name,
      });
      if (r?.ok) {
        setReg((prev) =>
          prev?.map((x) => (x === s ? { ...x, installed: true } : x)) ?? null,
        );
        void load();
      } else {
        setErrors([
          r?.candidates?.length
            ? `${r.error} Add ${s.repository} as a source to pick one: ${r.candidates.slice(0, 5).join(", ")}`
            : (r?.error ?? "Install failed"),
        ]);
      }
    } finally {
      setBusy(null);
    }
  };

  const shown = useMemo(() => {
    let list = (skills ?? []).filter(
      (s) =>
        (source === "all" || s.source === source) &&
        (filter === "all" ||
          (filter === "installed" ? s.installed : !s.installed)) &&
        matches(query, s.name, s.description, s.source, s.path),
    );
    list = [...list];
    if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "source")
      list.sort(
        (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
      );
    else
      list.sort(
        (a, b) =>
          Number(b.installed) - Number(a.installed) ||
          a.name.localeCompare(b.name),
      );
    return list;
  }, [skills, source, filter, sort, query]);

  return (
    <>
      <Toolbar
        chips={
          <>
            {sources.length > 1 && (
              <Chip
                label="All"
                active={source === "all"}
                onClick={() => setSource("all")}
              />
            )}
            {sources.map((s) => (
              <Chip
                key={s}
                label={s.split("/")[1] ?? s}
                title={s}
                active={source === s}
                onClick={() => setSource(source === s ? "all" : s)}
                onRemove={() => void removeSource(s)}
              />
            ))}
            {adding ? (
              <span className="inline-flex items-center gap-1 rounded-lg border border-foreground/30 px-2 py-1">
                <input
                  autoFocus
                  value={newSource}
                  onChange={(e) => setNewSource(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addSource();
                    if (e.key === "Escape") setAdding(false);
                  }}
                  placeholder="owner/repo or a GitHub URL"
                  className="w-56 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
                />
                <button
                  type="button"
                  onClick={() => void addSource()}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <Check className="size-3.5" />
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <Plus className="size-3.5" /> Add repo
              </button>
            )}
          </>
        }
        right={
          <>
            <button
              type="button"
              onClick={() => void load()}
              title="Reload the catalog"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
            >
              <RefreshCw
                className={reloading ? "size-4 animate-spin" : "size-4"}
              />
            </button>
            <Picker
              label="Filter by"
              value={filter}
              options={FILTERS}
              onChange={setFilter}
            />
            <Picker
              label="Sort by"
              value={sort}
              options={SORTS}
              onChange={setSort}
            />
          </>
        }
      />

      {errors.length > 0 && (
        <div className="mb-3 space-y-1">
          {errors.map((e) => (
            <p key={e} className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3 shrink-0" />
              <span className="break-words">{e}</span>
            </p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {skills === null ? (
          <Empty>
            <Loader2 className="mx-auto size-5 animate-spin" />
          </Empty>
        ) : shown.length === 0 ? (
          <Empty>
            {query
              ? `Nothing matches “${query}”.`
              : sources.length === 0
                ? "Add a repository to browse skills."
                : "No skills here."}
          </Empty>
        ) : (
          shown.map((s) => {
            const key = s.source + s.path;
            return (
              <DirCard
                key={key}
                title={`/${s.name}`}
                meta={
                  <>
                    <span className="truncate">{s.source}</span>
                    {s.installed && (
                      <span className="text-green-text">· installed</span>
                    )}
                  </>
                }
                description={s.description}
                action={
                  s.installed ? (
                    <CardAction
                      icon={Trash2}
                      title="Remove this skill"
                      variant="danger"
                      busy={busy === key}
                      onClick={() => void remove(s)}
                    />
                  ) : (
                    <CardAction
                      icon={Plus}
                      title="Install this skill"
                      busy={busy === key}
                      onClick={() => void install(s)}
                    />
                  )
                }
              />
            );
          })
        )}
      </div>

      {/* skillsdirectory.com. Nearly 97 000 entries, so it is searched rather
          than listed — it appears only once you have typed something. */}
      {query.trim().length >= 2 && (
        <div className="mt-5">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Globe className="size-3.5" />
            skillsdirectory.com
            {regBusy && <Loader2 className="size-3 animate-spin" />}
            {!regBusy && reg && <span>· {reg.length} found</span>}
          </div>
          {regError ? (
            <Empty>{regError}</Empty>
          ) : reg && reg.length === 0 && !regBusy ? (
            <Empty>{`Nothing in the directory matches “${query}”.`}</Empty>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {(reg ?? []).map((s) => {
                const key = `reg:${s.slug || s.repository + s.name}`;
                return (
                  <DirCard
                    key={key}
                    title={`/${s.name}`}
                    meta={
                      <>
                        <span className="truncate">{s.repository}</span>
                        {typeof s.stars === "number" && s.stars > 0 && (
                          <span>· ★ {s.stars.toLocaleString()}</span>
                        )}
                        {s.installed && (
                          <span className="text-green-text">· installed</span>
                        )}
                      </>
                    }
                    description={s.description}
                    action={
                      <CardAction
                        icon={Plus}
                        title="Install from skillsdirectory.com"
                        busy={busy === key}
                        onClick={() => void installFromRegistry(s, key)}
                      />
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Chips on the left, filter/sort on the right — shared by every section. */
export function Toolbar({
  chips,
  right,
}: {
  chips?: React.ReactNode;
  right?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {chips}
      </div>
      <div className="flex shrink-0 items-center gap-2">{right}</div>
    </div>
  );
}
