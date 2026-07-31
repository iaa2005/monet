/**
 * models.dev catalog browser — pick a model instead of typing its id.
 *
 * The provider editor's "Add model" creates an empty row: the user types an
 * id and leaves the context window and modalities blank, because nobody knows
 * those by heart. Blank modalities used to mean text-only, so an attached
 * screenshot was quietly dropped on the way to a model that could have read it.
 *
 * This fills all of it in from the published catalog (~5800 models). Same role
 * as OpenRouterBrowser, but for every other provider — OpenRouter has its own
 * live endpoint and keeps using it.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, Plus, RefreshCw, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CatalogModelInfo, CatalogProviderInfo } from "@/types/electron";
import type { ProviderModel } from "@/stores/providerStore";
import { ModalityBadges } from "./ModalityBadges";

function api(): Window["electronAPI"] {
  return (window as unknown as { electronAPI: Window["electronAPI"] })
    .electronAPI;
}

function fmtContext(n: number | undefined): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  return `${Math.round(n / 1000)}K`;
}

function fmtPrice(per1M: number | undefined): string {
  if (per1M === undefined) return "—";
  if (per1M === 0) return "free";
  return per1M < 1 ? `$${per1M.toFixed(2)}` : `$${per1M.toFixed(0)}`;
}

function fmtAge(ms: number | null | undefined): string {
  if (ms == null) return "";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "updated just now";
  if (h < 24) return `updated ${h}h ago`;
  return `updated ${Math.floor(h / 24)}d ago`;
}

/** Guess which catalog provider matches the one being edited, so the list
 * opens on something useful instead of at "Alibaba". */
function guessProviderId(
  providers: CatalogProviderInfo[],
  kind: string,
  baseURL: string,
): string {
  const url = baseURL.toLowerCase();
  const byUrl = providers.find(
    (p) => p.baseURL && url.startsWith(p.baseURL.toLowerCase().slice(0, 24)),
  );
  if (byUrl) return byUrl.id;
  const direct = providers.find((p) => p.id === kind);
  if (direct) return direct.id;
  return providers[0]?.id ?? "";
}

export function CatalogBrowser({
  kind,
  baseURL,
  existingNames,
  onAdd,
  onClose,
}: {
  kind: string;
  baseURL: string;
  existingNames: Set<string>;
  onAdd: (m: ProviderModel) => void;
  onClose: () => void;
}): JSX.Element {
  const [providers, setProviders] = useState<CatalogProviderInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [models, setModels] = useState<CatalogModelInfo[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ageMs, setAgeMs] = useState<number | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  const load = async (force = false): Promise<void> => {
    setLoading(true);
    setError("");
    const r = await api().providers.catalogProviders(force);
    setLoading(false);
    if (!r.ok || !r.providers) {
      setError(r.error ?? "Could not load the catalog");
      return;
    }
    setProviders(r.providers);
    setAgeMs(r.ageMs ?? null);
    setSelected((cur) => cur || guessProviderId(r.providers!, kind, baseURL));
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    void api()
      .providers.catalogModels(selected)
      .then((r) => {
        if (alive && r.ok && r.models) setModels(r.models);
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
    );
  }, [models, query]);

  const add = (m: CatalogModelInfo): void => {
    onAdd({
      id: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2),
      name: m.id,
      label: m.label !== m.id ? m.label : undefined,
      contextLength: m.contextLength,
      maxInputTokens: m.maxInputTokens,
      maxOutputTokens: m.maxOutputTokens,
      modalities: m.modalities,
      supportsEffort: m.supportsEffort,
      pricing: m.pricing,
    } as ProviderModel);
    setAdded((prev) => new Set(prev).add(m.id));
  };

  return (
    // z-[60], above the provider editor that opened this — at the editor's own
    // z-50 the stacking order is whatever the DOM order happens to be.
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        // Without this every click inside reached the provider editor's own
        // backdrop — which closes on any bubbled click — so clicking anything
        // in the catalog shut the whole editor. The editor now also ignores
        // bubbled clicks, but a modal should stop its own regardless.
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <h3 className="text-base font-semibold">Model catalog</h3>
            <p className="text-xs text-muted-foreground">
              Context window, modalities and pricing come from models.dev —
              nothing to type by hand. {fmtAge(ageMs)}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void load(true)}
              title="Re-download the catalog"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
            >
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="max-w-56 shrink-0 rounded-lg border border-border bg-card px-2 py-1.5 text-sm"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({p.modelCount})
              </option>
            ))}
          </select>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter models…"
              className="w-full rounded-lg border border-border bg-card py-1.5 pl-8 pr-2 text-sm outline-none focus:border-foreground/25"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && (
            <div className="p-6 text-center text-sm text-destructive">
              {error}
            </div>
          )}
          {!error && loading && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              Loading the catalog…
            </div>
          )}
          {!error && !loading && filtered.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No models match “{query}”.
            </div>
          )}
          {filtered.map((m) => {
            const already = existingNames.has(m.id) || added.has(m.id);
            return (
              <div
                key={m.id}
                className="flex items-center gap-3 border-b border-border px-5 py-2.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{m.label}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {m.id}
                  </div>
                </div>
                <ModalityBadges modalities={m.modalities} />
                <span
                  className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                  title="Context window"
                >
                  {fmtContext(m.contextLength)}
                </span>
                <span
                  className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                  title="Per 1M tokens, in / out"
                >
                  {fmtPrice(m.pricing?.promptPer1M)} /{" "}
                  {fmtPrice(m.pricing?.completionPer1M)}
                </span>
                <button
                  type="button"
                  disabled={already}
                  onClick={() => add(m)}
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors",
                    already
                      ? "text-muted-foreground"
                      : "bg-foreground text-background hover:opacity-90",
                  )}
                >
                  {already ? (
                    <>
                      <Check className="size-3.5" /> Added
                    </>
                  ) : (
                    <>
                      <Plus className="size-3.5" /> Add
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
