/**
 * Directory → Skills.
 *
 * A source is a place to look for skills, and the chips are its on/off switch —
 * nothing more. Off means not listed and not fetched. What ships with the app
 * can be switched off but not deleted; everything else can be both.
 *
 * ONE row. Sources curated in the community repo appear among the switches
 * rather than in a separate "Suggested sources" strip you added them from —
 * that was two concepts (a source you have, a source you could have) for one
 * thing. Adding one for everybody is still a JSON edit and a push.
 *
 * The row also replaced a "filter the grid by source" reading of the same
 * chips, which nothing on screen explained and which shared its space with a
 * delete button.
 *
 * Two kinds of source. A GitHub repo whose folders hold a SKILL.md is
 * enumerated — one tree request, complete listing. skillsdirectory.com is an
 * INDEX of such repos, ~97 000 entries, so it is paged: query and category go
 * to the server, and more arrives as the grid is scrolled.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { SkillSource, StoreSkill } from "@/types/electron";
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
import { OwnerAvatar, ownerOf } from "./OwnerAvatar";
import { groupByRepo, type RepoGroup } from "./group-by-repo";
import { SkillPreview } from "./SkillPreview";

const FILTERS = [
  { label: "All", value: "all" },
  { label: "Installed", value: "installed" },
  { label: "Not installed", value: "available" },
];
/** Must match REGISTRY_PAGE in the main process — the offset it pages by. */
const REGISTRY_PAGE = 100;

const SORTS = [
  { label: "Most installed", value: "installs" },
  { label: "Most stars", value: "stars" },
  { label: "Name", value: "name" },
  { label: "Source", value: "source" },
  { label: "Installed first", value: "installed" },
];

/**
 * The keys a registry can order by itself.
 *
 * These go to the main process, because a registry is PAGED: re-ordering the
 * hundred rows already on screen would answer "the most-installed of an
 * arbitrary hundred", which is not the question. claudemarketplaces sorts its
 * whole 23 472-row snapshot; skillsdirectory has a server-side stars sort and no
 * install counts at all.
 */
const SERVER_SORTS = new Set(["installs", "stars", "name"]);

/** What a switched-off source looks like, spelled out once: the row is a set of
 * switches, so an empty grid should say which switch to flip. */
const ALL_OFF = "Every source is switched off — turn one on above.";

/** 150400 → 150k. Exact counts in a meta line are noise. */
function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function SkillsSection({ query }: { query: string }): JSX.Element {
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [skills, setSkills] = useState<StoreSkill[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("installs");
  const [adding, setAdding] = useState(false);
  const [newSource, setNewSource] = useState("");
  const [reloading, setReloading] = useState(false);
  // The registry is paged, not listed — ~97 000 entries, 100 per request. The
  // first page arrives with `load`; the rest as the user reaches the bottom.
  const [regOffset, setRegOffset] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreDone, setMoreDone] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const [category, setCategory] = useState("all");
  const [catSlugs, setCatSlugs] = useState<string[]>([]);
  /** Which repository groups are expanded. Collapsed by default: a repo with
   * thirty skills should cost one row until it is asked for. */
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  /** The card being read before installing. */
  const [previewing, setPreviewing] = useState<StoreSkill | null>(null);
  /**
   * The only place a listing is fetched.
   *
   * It used to be three effects — mount, query, category — each calling its own
   * `load`. Two could be in flight at once and the older response could land
   * last, which is why filtering by category appeared to work once and then
   * stop, and why the source chips flickered: every response overwrote both
   * lists. A token makes the newest request the only one allowed to write.
   */
  const reqId = useRef(0);

  const load = async (): Promise<void> => {
    const mine = ++reqId.current;
    setReloading(true);
    try {
      const [srcs, r] = await Promise.all([
        api()?.skillStore.getSources(),
        // The query and category go to the MAIN process: a registry source is
        // paged, not enumerated, so both must be applied server-side rather
        // than filtered over the hundred rows already fetched.
        api()?.skillStore.list({
          query,
          category: category === "all" ? undefined : category,
          sort: SERVER_SORTS.has(sort) ? sort : undefined,
        }),
      ]);
      // A newer request started while this one was out — its answer is the
      // current one, and writing this stale one would undo it.
      if (mine !== reqId.current) return;
      setSources(srcs ?? []);
      setSkills(r?.ok ? (r.skills ?? []) : []);
      setRegOffset(0);
      setMoreDone(false);
      setErrors(r?.ok ? (r.errors ?? []) : [r?.error ?? "Failed to load"]);
    } finally {
      if (mine === reqId.current) setReloading(false);
    }
  };

  // One effect for every input. The debounce is for the query — a registry
  // search is a request to someone else's server on each keystroke — and
  // costs nothing on a category change or first paint.
  useEffect(() => {
    const t = setTimeout(() => void load(), query ? 400 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, category, sort]);

  useEffect(() => {
    void api()
      ?.skillStore.categories()
      .then((c) => setCatSlugs(c ?? []))
      .catch(() => {});
  }, []);

  const hasRegistry = sources.some((s) => s.kind === "registry" && s.enabled);

  /** How a source goes back into the config. */
  const stored = (x: SkillSource): unknown =>
    x.kind === "github" && x.enabled
      ? x.id
      : { kind: x.kind, id: x.id, enabled: x.enabled };

  const save = async (list: unknown[]): Promise<void> => {
    const next = await api()?.skillStore.setSources(list);
    setSources(next ?? sources);
    await load();
  };

  const addSource = async (): Promise<void> => {
    const v = newSource.trim();
    if (!v) return;
    setNewSource("");
    setAdding(false);
    await save([...sources.map(stored), v]);
  };

  /**
   * The whole interaction: a source is on or off.
   *
   * It used to be a view filter — clicking a chip hid the other sources'
   * cards — which read as arbitrary because nothing said so and the labels
   * were unrecognisable. On/off is the thing a person actually wants, and a
   * switched-off source is not fetched at all.
   */
  const toggleSource = async (id: string): Promise<void> => {
    await save(
      sources.map((x) => (x.id === id ? stored({ ...x, enabled: !x.enabled }) : stored(x))),
    );
  };

  /** Only a source the user added. A built-in can be switched off; deleting it
   * would leave no way back short of typing its id. */
  const removeSource = async (id: string): Promise<void> => {
    await save(sources.filter((x) => x.id !== id).map(stored));
  };

  const install = async (s: StoreSkill): Promise<void> => {
    setBusy(s.uid);
    try {
      const r = await api()?.skillStore.install({
        source: s.source,
        path: s.path,
        uid: s.uid,
        kind: s.kind,
        repository: s.repository,
        hint: s.hint,
        name: s.name,
      });
      // Matched on uid. source+path marked every registry card at once — they
      // all have an empty path — and marked a same-named skill from another
      // repo as installed too.
      if (r?.ok) {
        setSkills(
          (prev) =>
            prev?.map((x) =>
              x.uid === s.uid
                ? { ...x, installed: true, slug: r.slug ?? x.slug }
                : x,
            ) ?? null,
        );
        // The open preview holds its own copy of the card, so without this it
        // keeps offering Install for something already installed.
        setPreviewing((p) =>
          p && p.uid === s.uid ? { ...p, installed: true, slug: r.slug ?? p.slug } : p,
        );
      } else
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
    setBusy(s.uid);
    try {
      // s.slug is the folder THIS card installed, resolved from the recorded
      // origin — not slugify(name), which pointed at whichever same-named
      // skill landed first.
      await api()?.skills.deleteBySlug(s.slug);
      setSkills(
        (prev) =>
          prev?.map((x) => (x.uid === s.uid ? { ...x, installed: false } : x)) ??
          null,
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
        // The same key the first page used, or page two would come from a
        // different ordering and repeat or skip rows.
        sort: SERVER_SORTS.has(sort) ? sort : undefined,
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
    // No source filter here any more: a switched-off source is not fetched, so
    // there is nothing of its to hide. The query is still applied locally for
    // the github sources, whose listings are complete rather than paged.
    let list = (skills ?? []).filter(
      (s) =>
        (filter === "all" ||
          (filter === "installed" ? s.installed : !s.installed)) &&
        matches(query, s.name, s.description, s.source, s.path),
    );
    list = [...list];
    // The registry pages already arrive in the chosen order; this settles the
    // MERGED view, where a repo source's cards (which have neither figure) sit
    // beside a registry's. A missing count sorts last rather than as zero-ish
    // noise in the middle.
    const num = (v: number | undefined): number => v ?? -1;
    if (sort === "installs")
      list.sort(
        (a, b) => num(b.installs) - num(a.installs) || a.name.localeCompare(b.name),
      );
    else if (sort === "stars")
      list.sort((a, b) => num(b.stars) - num(a.stars) || a.name.localeCompare(b.name));
    else if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
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
  }, [skills, filter, sort, query]);

  /** One card. Shared by loose cards and the ones inside a group, so the two
   * cannot drift apart. */
  const renderCard = (s: StoreSkill): JSX.Element => {
    const key = s.uid;
    return (
              <DirCard
                key={key}
                title={`/${s.name}`}
                meta={
                  <>
                    {/* The REPOSITORY, not the source id. There are nineteen
                        skills called `docx` in the directory, each in a
                        different repo — "claudemarketplaces" on all of them
                        told you nothing about which one you were looking at. */}
                    <span className="truncate">
                      {s.repository ?? s.source}
                      {s.hint && s.hint !== s.name ? `/${s.hint}` : ""}
                    </span>
                    {typeof s.installs === "number" && s.installs > 0 && (
                      <span className="shrink-0">
                        · {fmtCount(s.installs)} installs
                      </span>
                    )}
                    {typeof s.stars === "number" && s.stars > 0 && (
                      // The repo's stars, said so: nineteen `docx` skills
                      // inherit their repos' figures and none of it is about
                      // the skill.
                      <span className="shrink-0" title="Stars on the repository, not the skill">
                        · ★ {fmtCount(s.stars)}
                      </span>
                    )}
                    {s.installed && (
                      <span className="shrink-0 text-green-text">· installed</span>
                    )}
                  </>
                }
                description={s.description}
                action={
                  <>
                    {/* Read it first. A skill is instructions the model will
                        follow, and these come from strangers' repositories.
                        The preview shows SKILL.md here; the link to the real
                        page lives inside it, next to the audit buttons. */}
                    <CardAction
                      icon={Eye}
                      title="Read this skill before installing"
                      onClick={() => setPreviewing(s)}
                    />
                    {s.installed ? (
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
                  )}
                  </>
                }
              />
    );
  };

  /** The sorted list with each repository's run collapsed into one row. The
   * order is the picker's — a group sits where its first member did. */
  const rows = useMemo(() => groupByRepo(shown), [shown]);

  const toggleGroup = (key: string): void =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      <Toolbar
        chips={
          <>
            <span className="mr-0.5 shrink-0 self-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Sources
            </span>
            {sources.map((s) => (
              <Chip
                key={s.id}
                label={sourceLabels.get(s.id) ?? s.id}
                title={
                  (s.enabled ? "On — click to switch off. " : "Off — click to switch on. ") +
                  (s.kind === "registry" ? (s.homepage ?? s.name ?? s.id) : s.id) +
                  (s.builtin ? " (built in, cannot be removed)" : "")
                }
                active={s.enabled}
                onClick={() => void toggleSource(s.id)}
                // Built-ins switch off but never disappear; only what the user
                // added can be deleted.
                onRemove={s.builtin ? undefined : () => void removeSource(s.id)}
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

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {skills === null ? (
          <Empty>
            <Loader2 className="mx-auto size-5 animate-spin" />
          </Empty>
        ) : shown.length === 0 ? (
          <Empty>
            {sources.every((s) => !s.enabled)
              ? ALL_OFF
              : query
                ? `Nothing matches “${query}”.`
                : "No skills here."}
          </Empty>
        ) : (
          rows.map((row) =>
            row.kind === "one" ? (
              renderCard(row.item)
            ) : (
              <RepoGroupCard
                key={`g:${row.group.key}`}
                group={row.group}
                open={openGroups.has(row.group.key)}
                onToggle={() => toggleGroup(row.group.key)}
                renderCard={renderCard}
              />
            ),
          )
        )}
      </div>

      {/* Read it, and see the audit, before it becomes instructions the model
          follows. Keyed by uid so switching skills starts over rather than
          carrying the previous verdict across. */}
      {previewing && (
        <SkillPreview
          key={previewing.uid}
          skill={previewing}
          installing={busy === previewing.uid}
          onInstall={() => void install(previewing)}
          onClose={() => setPreviewing(null)}
        />
      )}
    </>
  );
}

/**
 * One repository, collapsed.
 *
 * microsoft/azure-skills publishes dozens of skills. Flat, they filled the grid
 * with the same repository, the same 448k installs and the same star count over
 * and over, pushing everyone else's work off screen. Collapsed, the repo costs
 * one row and hides nothing — a click opens it.
 *
 * Open, it spans both columns, so its skills read as a list belonging to it
 * rather than cards that happen to sit nearby.
 */
function RepoGroupCard({
  group,
  open,
  onToggle,
  renderCard,
}: {
  group: RepoGroup<StoreSkill>;
  open: boolean;
  onToggle: () => void;
  renderCard: (s: StoreSkill) => JSX.Element;
}): JSX.Element {
  return (
    <div className={cn("rounded-xl border border-border", open && "lg:col-span-2")}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-2.5 p-4 text-left"
      >
        <OwnerAvatar owner={ownerOf(group.key)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium leading-tight">
            {group.key}
          </span>
          <span className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
            <span>{group.items.length} skills</span>
            {group.installedCount > 0 && (
              <span className="text-green-text">
                · {group.installedCount} installed
              </span>
            )}
            {typeof group.installs === "number" && group.installs > 0 && (
              <span className="shrink-0">
                · {fmtCount(group.installs)} installs
              </span>
            )}
            {typeof group.stars === "number" && group.stars > 0 && (
              <span
                className="shrink-0"
                title="Stars on the repository, not the skill"
              >
                · ★ {fmtCount(group.stars)}
              </span>
            )}
          </span>
        </span>
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {open ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-1 gap-3 border-t border-border p-3 lg:grid-cols-2">
          {group.items.map(renderCard)}
        </div>
      )}
    </div>
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
