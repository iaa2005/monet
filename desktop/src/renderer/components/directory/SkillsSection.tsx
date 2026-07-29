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

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Globe, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { SkillSource, StoreSkill, SuggestedSource } from "@/types/electron";
import {
  api,
  CardAction,
  Chip,
  DirCard,
  Empty,
  matches,
  Picker,
} from "./shared";
import { sourceChipLabels } from "./source-labels";

const FILTERS = [
  { label: "All", value: "all" },
  { label: "Installed", value: "installed" },
  { label: "Not installed", value: "available" },
];
/** Must match REGISTRY_PAGE in the main process — the offset it pages by. */
const REGISTRY_PAGE = 100;

const SORTS = [
  { label: "Name", value: "name" },
  { label: "Source", value: "source" },
  { label: "Installed first", value: "installed" },
];

export function SkillsSection({ query }: { query: string }): JSX.Element {
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [skills, setSkills] = useState<StoreSkill[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [source, setSource] = useState("all");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("name");
  const [adding, setAdding] = useState(false);
  const [newSource, setNewSource] = useState("");
  const [reloading, setReloading] = useState(false);
  // Curated sources from the community repo — offered, never auto-added.
  const [suggested, setSuggested] = useState<SuggestedSource[]>([]);
  // The registry is paged, not listed — ~97 000 entries, 100 per request. The
  // first page arrives with `load`; the rest as the user reaches the bottom.
  const [regOffset, setRegOffset] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreDone, setMoreDone] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const [category, setCategory] = useState("all");
  const [catSlugs, setCatSlugs] = useState<string[]>([]);
  const load = async (q = query): Promise<void> => {
    setReloading(true);
    try {
      const [srcs, r] = await Promise.all([
        api()?.skillStore.getSources(),
        // The query goes to the MAIN process too: a registry source is paged,
        // not enumerated, so it must search server-side rather than be
        // filtered client-side like a repo's listing.
        api()?.skillStore.list({
          query: q,
          category: category === "all" ? undefined : category,
        }),
      ]);
      setSources(srcs ?? []);
      setSkills(r?.ok ? (r.skills ?? []) : []);
      // A new listing restarts the registry paging — the pages that follow
      // belong to this query, not the previous one.
      setRegOffset(0);
      setMoreDone(false);
      setErrors(r?.ok ? (r.errors ?? []) : [r?.error ?? "Failed to load"]);
    } finally {
      setReloading(false);
    }
  };

  useEffect(() => {
    void load();
    void api()
      ?.skillStore.categories()
      .then((c) => setCatSlugs(c ?? []))
      .catch(() => {});
    void api()
      ?.skillStore.suggestions()
      .then((r) => setSuggested(r?.sources ?? []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A registry source is searched on the server, so a new query means a new
  // request — debounced, or every keystroke hits skillsdirectory.com.
  const hasRegistry = sources.some((s) => s.kind === "registry");
  useEffect(() => {
    if (!hasRegistry) return;
    const t = setTimeout(() => void load(query), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, hasRegistry]);

  // The category is a SERVER-side filter: "development" alone matches 22 389
  // entries, so narrowing the hundred already on screen would narrow the wrong
  // hundred. Changing it therefore re-queries rather than re-filters.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    void load(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  const addSource = async (): Promise<void> => {
    const v = newSource.trim();
    if (!v) return;
    // Sources go back as the config stores them: a bare string for a repo,
    // an object for anything else.
    const next = await api()?.skillStore.setSources([
      ...sources.map((x) => (x.kind === "github" ? x.id : { kind: x.kind, id: x.id })),
      v,
    ]);
    setSources(next ?? sources);
    setNewSource("");
    setAdding(false);
    await load();
  };

  /** Add a curated source. It is a place to look for skills, not code — the
   * install path is unchanged, so nothing runs until the user installs. */
  const addSuggested = async (s: SuggestedSource): Promise<void> => {
    const next = await api()?.skillStore.setSources([
      ...sources.map((x) => (x.kind === "github" ? x.id : { kind: x.kind, id: x.id })),
      s.kind === "github" ? (s.repo ?? s.id) : { kind: s.kind, id: s.id, api: s.api },
    ]);
    setSources(next ?? sources);
    setSuggested((prev) =>
      prev.map((x) => (x.id === s.id ? { ...x, added: true } : x)),
    );
    await load();
  };

  const removeSource = async (id: string): Promise<void> => {
    const next = await api()?.skillStore.setSources(
      sources
        .filter((x) => x.id !== id)
        .map((x) => (x.kind === "github" ? x.id : { kind: x.kind, id: x.id })),
    );
    setSources(next ?? sources);
    if (source === id) setSource("all");
    await load();
  };

  const install = async (s: StoreSkill): Promise<void> => {
    setBusy(s.source + s.path);
    try {
      const r = await api()?.skillStore.install({
        source: s.source,
        path: s.path,
        kind: s.kind,
        repository: s.repository,
        name: s.name,
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
      else
        setErrors([
          r?.candidates?.length
            ? `${r.error} Add ${s.repository} as a source to choose: ${r.candidates.slice(0, 5).join(", ")}`
            : (r?.error ?? "Install failed"),
        ]);
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

  /**
   * The next registry page, appended.
   *
   * De-duplicated by source+repository+name: paging by offset over a list that
   * is still being published can hand back a row already on screen, and a
   * duplicate card is one the user cannot tell from the original.
   */
  const loadMore = async (): Promise<void> => {
    if (moreBusy || moreDone) return;
    setMoreBusy(true);
    try {
      const next = regOffset + REGISTRY_PAGE;
      const r = await api()?.skillStore.registryPage({
        query,
        offset: next,
        category: category === "all" ? undefined : category,
      });
      const page = r?.ok ? (r.skills ?? []) : [];
      // A short page means the registry has no more to give for this query.
      if (!r?.ok || page.length === 0) {
        setMoreDone(true);
        return;
      }
      setRegOffset(next);
      setSkills((prev) => {
        const have = new Set(
          (prev ?? []).map((s) => `${s.source}|${s.repository ?? ""}|${s.name}`),
        );
        const fresh = page.filter(
          (s) => !have.has(`${s.source}|${s.repository ?? ""}|${s.name}`),
        );
        // Every row was already on screen — offset is past the useful end.
        if (fresh.length === 0) setMoreDone(true);
        return [...(prev ?? []), ...fresh];
      });
    } finally {
      setMoreBusy(false);
    }
  };

  // Load on reaching the bottom. An observer rather than a scroll handler: the
  // grid sits in whatever container the Directory gives it, and this does not
  // need to know which one scrolls.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasRegistry || moreDone) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRegistry, moreDone, moreBusy, regOffset, query, skills?.length]);

  /** Seeded from the directory's published list, unioned with whatever the
   * loaded cards actually carry — a category added upstream shows up as soon
   * as it appears in results, without waiting for a release here. */
  const categories = useMemo(() => {
    const seen = new Set<string>(catSlugs);
    for (const s of skills ?? []) if (s.category) seen.add(s.category);
    return [
      { label: "All categories", value: "all" },
      ...[...seen].sort().map((c) => ({
        label: c.replace(/-/g, " ").replace(/^./, (m) => m.toUpperCase()),
        value: c,
      })),
    ];
  }, [catSlugs, skills]);

  /** See source-labels.ts — the rule is there so it can be tested. */
  const sourceLabels = useMemo(() => sourceChipLabels(sources), [sources]);

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
            <span className="mr-0.5 shrink-0 self-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Source
            </span>
            {sources.length > 1 && (
              <Chip
                label="All"
                title="Show skills from every source"
                active={source === "all"}
                onClick={() => setSource("all")}
              />
            )}
            {sources.map((s) => (
              <Chip
                key={s.id}
                label={sourceLabels.get(s.id) ?? s.id}
                title={`Show only skills from ${s.kind === "registry" ? (s.homepage ?? s.name ?? s.id) : s.id} — click again to show all`}
                active={source === s.id}
                onClick={() => setSource(source === s.id ? "all" : s.id)}
                onRemove={() => void removeSource(s.id)}
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
            {hasRegistry && (
              <Picker
                label="Category"
                value={category}
                options={categories}
                onChange={setCategory}
              />
            )}
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

      {/* Curated in the community repo (skill-sources.json), so a new source
          reaches everyone with a push rather than an app release. Offered, not
          added: a source is somewhere to look, and the user chooses. */}
      {suggested.some((x) => !x.added) && (
        <div className="mb-4">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Suggested sources
          </div>
          <div className="flex flex-wrap gap-2">
            {suggested
              .filter((x) => !x.added)
              .map((x) => (
                <button
                  key={x.id}
                  type="button"
                  title={x.description ?? x.homepage ?? x.repo ?? x.id}
                  onClick={() => void addSuggested(x)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                >
                  {x.kind === "registry" ? (
                    <Globe className="size-3.5 text-muted-foreground" />
                  ) : (
                    <Plus className="size-3.5 text-muted-foreground" />
                  )}
                  <span>{x.name}</span>
                </button>
              ))}
          </div>
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
