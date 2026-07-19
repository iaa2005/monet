/**
 * OpenRouter Model Browser — searchable table that fetches the live model
 * catalog from OpenRouter and lets the user add models with auto-populated
 * parameters (context length, pricing, modalities, effort support, max output).
 *
 * Triggered from the provider editor when kind === "openrouter".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ORModel, ORKeyInfo } from "@/types/electron";
import type { ProviderModel, Modality } from "@/stores/providerStore";
import { MODALITY_META } from "./ModalityBadges";
import { ModalityBadges } from "./ModalityBadges";

// ─── Helpers ─────────────────────────────────────────────────────────────

function pricePerMillion(perTokenStr: string | undefined): number | undefined {
  if (!perTokenStr) return undefined;
  const perToken = parseFloat(perTokenStr);
  // Negative = "variable/BYOK" sentinel — unknown, not a negative price.
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  return Math.round(perToken * 1_000_000 * 100) / 100;
}

function orModalities(input?: string[]): Modality[] {
  if (!input || input.length === 0) return ["text"];
  const out: Modality[] = ["text"];
  if (input.includes("image")) out.push("image");
  if (input.includes("audio")) out.push("audio");
  if (input.includes("file")) out.push("file");
  if (input.includes("video")) out.push("video");
  return out;
}

function orSupportsEffort(m: ORModel): boolean {
  const p = m.supported_parameters ?? [];
  return (
    p.includes("reasoning") ||
    p.includes("include_reasoning") ||
    p.includes("reasoning_effort")
  );
}

function fmtPrice(per1M: number | undefined): string {
  if (per1M === undefined) return "—";
  if (per1M === 0) return "free";
  if (per1M < 1) return `$${per1M.toFixed(2)}`;
  return `$${per1M.toFixed(0)}`;
}

function fmtCtx(n: number | undefined): string {
  if (!n) return "—";
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function orToProviderModel(m: ORModel): ProviderModel {
  const promptPrice = pricePerMillion(m.pricing?.prompt);
  const completionPrice = pricePerMillion(m.pricing?.completion);
  return {
    id: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2),
    name: m.id,
    label: m.name,
    contextLength: m.context_length,
    // Not every model reports a max — leave it unset then (the request layer
    // has its own default) instead of asserting a number we invented.
    ...(m.top_provider?.max_completion_tokens != null
      ? { maxOutputTokens: m.top_provider.max_completion_tokens }
      : {}),
    modalities: orModalities(m.architecture?.input_modalities),
    supportsEffort: orSupportsEffort(m),
    ...(promptPrice !== undefined && completionPrice !== undefined
      ? { pricing: { promptPer1M: promptPrice, completionPer1M: completionPrice } }
      : {}),
  };
}

// ─── Sort ────────────────────────────────────────────────────────────────

type SortKey = "name" | "id" | "input" | "output" | "context";
type SortDir = "asc" | "desc";

function getSortValue(m: ORModel, key: SortKey): number | string {
  switch (key) {
    case "name":
      return m.name.toLowerCase();
    case "id":
      return m.id.toLowerCase();
    case "input":
      return pricePerMillion(m.pricing?.prompt) ?? Infinity;
    case "output":
      return pricePerMillion(m.pricing?.completion) ?? Infinity;
    case "context":
      return m.context_length ?? 0;
  }
}

// ─── Component ─────────────────────────────────────────────────────────────

export function OpenRouterBrowser({
  apiKey,
  existingNames,
  onAdd,
  onClose,
}: {
  apiKey: string;
  existingNames: Set<string>;
  onAdd: (model: ProviderModel) => void;
  onClose: () => void;
}): JSX.Element {
  const [models, setModels] = useState<ORModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [keyInfo, setKeyInfo] = useState<ORKeyInfo | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [inFilter, setInFilter] = useState<Set<Modality>>(new Set());
  const [outFilter, setOutFilter] = useState<Set<Modality>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!apiKey) {
      setError("Enter an API key first");
      setLoading(false);
      return;
    }
    abortRef.current = new AbortController();
    const sig = abortRef.current.signal;

    (async () => {
      try {
        const [modelsRes, keyRes] = await Promise.all([
          window.electronAPI.providers.orModels(apiKey),
          window.electronAPI.providers.orKeyInfo(apiKey),
        ]);
        if (sig.aborted) return;
        if (!modelsRes.ok) {
          setError(modelsRes.error || "Failed to fetch models");
          setLoading(false);
          return;
        }
        setModels((modelsRes.models as ORModel[]) ?? []);
        if (keyRes.ok && keyRes.info) {
          setKeyInfo(keyRes.info as ORKeyInfo);
        }
        setLoading(false);
      } catch (err) {
        if (sig.aborted) return;
        setError(String(err));
        setLoading(false);
      }
    })();

    return () => abortRef.current?.abort();
  }, [apiKey]);

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const toggleInFilter = (mod: Modality): void => {
    setInFilter((prev) => {
      const next = new Set(prev);
      if (next.has(mod)) next.delete(mod);
      else next.add(mod);
      return next;
    });
  };

  const toggleOutFilter = (mod: Modality): void => {
    setOutFilter((prev) => {
      const next = new Set(prev);
      if (next.has(mod)) next.delete(mod);
      else next.add(mod);
      return next;
    });
  };

  const filtered = useCallback(() => {
    let out = models;
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter(
        (m) =>
          m.id.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          m.id.split("/")[0]?.toLowerCase().includes(q),
      );
    }
    if (inFilter.size > 0) {
      out = out.filter((m) => {
        const mods = orModalities(m.architecture?.input_modalities);
        return [...inFilter].every((f) => mods.includes(f));
      });
    }
    if (outFilter.size > 0) {
      out = out.filter((m) => {
        const mods = orModalities(m.architecture?.output_modalities);
        return [...outFilter].every((f) => mods.includes(f));
      });
    }
    return out;
  }, [models, query, inFilter, outFilter]);

  const results = [...filtered()].sort((a, b) => {
    const va = getSortValue(a, sortKey);
    const vb = getSortValue(b, sortKey);
    let cmp: number;
    if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb));
    return sortDir === "asc" ? cmp : -cmp;
  });

  function SortHeader({
    label,
    colKey,
    align = "right",
  }: {
    label: string;
    colKey: SortKey;
    align?: "left" | "right" | "center";
  }): JSX.Element {
    const active = colKey === sortKey;
    return (
      <th
        className={cn(
          "px-2 py-2 font-medium",
          align === "right" && "text-right",
          align === "center" && "text-center",
          align === "left" && "text-left",
        )}
      >
        <button
          type="button"
          onClick={() => toggleSort(colKey)}
          className={cn(
            "inline-flex items-center gap-1 transition-colors hover:text-foreground",
            active && "text-foreground",
          )}
        >
          {label}
          {active &&
            (sortDir === "asc" ? (
              <ArrowUp className="size-4" />
            ) : (
              <ArrowDown className="size-4" />
            ))}
        </button>
      </th>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-7xl flex-col rounded-2xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-3 pt-5">
          <div>
            <h3 className="text-base font-semibold">Browse OpenRouter Models</h3>
            {keyInfo && (
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {keyInfo.isFreeTier ? "Free tier" : "Balance"}:{" "}
                {keyInfo.balance != null
                  ? `$${keyInfo.balance.toFixed(2)}`
                  : "unknown"}
                {keyInfo.totalUsage != null &&
                  ` · $${keyInfo.totalUsage.toFixed(2)} spent`}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models, companies…"
              className="w-full rounded-lg border border-border bg-background py-2 pl-10 pr-3 text-sm outline-none focus:ring-1 focus:ring-foreground/20"
            />
          </div>
          {!loading && !error && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {results.length} models
            </p>
          )}
        </div>

        {/* Table */}
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-2">
          {loading && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Fetching model catalog…
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {!loading && !error && (
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-[12px] text-muted-foreground">
                  <SortHeader label="Name" colKey="name" align="left" />
                  <SortHeader label="ID" colKey="id" align="left" />
                  <SortHeader label="Input" colKey="input" />
                  <SortHeader label="Output" colKey="output" />
                  <SortHeader label="Context" colKey="context" />
                  <th className="px-2 py-2 text-center font-medium">
                    <div className="flex flex-col items-center gap-1">
                      <span>In</span>
                      <div className="flex items-center gap-0.5">
                        {MODALITY_META.map((m) => {
                          const on = inFilter.has(m.id);
                          return (
                            <button
                              key={m.id}
                              type="button"
                              title={`Filter: ${m.label}`}
                              onClick={() => toggleInFilter(m.id)}
                              className={cn(
                                "flex size-5 items-center justify-center rounded transition-colors",
                                on
                                  ? cn("bg-black/[0.06] dark:bg-white/[0.08]", m.color)
                                  : "text-muted-foreground/30 hover:text-muted-foreground",
                              )}
                            >
                              <m.Icon className="size-4" />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </th>
                  <th className="px-2 py-2 text-center font-medium">
                    <div className="flex flex-col items-center gap-1">
                      <span>Out</span>
                      <div className="flex items-center gap-0.5">
                        {MODALITY_META.map((m) => {
                          const on = outFilter.has(m.id);
                          return (
                            <button
                              key={m.id}
                              type="button"
                              title={`Filter: ${m.label}`}
                              onClick={() => toggleOutFilter(m.id)}
                              className={cn(
                                "flex size-5 items-center justify-center rounded transition-colors",
                                on
                                  ? cn("bg-black/[0.06] dark:bg-white/[0.08]", m.color)
                                  : "text-muted-foreground/30 hover:text-muted-foreground",
                              )}
                            >
                              <m.Icon className="size-4" />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </th>
                  <th className="px-2 py-2 text-center font-medium">Reasoning</th>
                  <th className="px-2 py-2 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {results.map((m) => {
                  const exists = existingNames.has(m.id);
                  const promptPrice = pricePerMillion(m.pricing?.prompt);
                  const completionPrice = pricePerMillion(m.pricing?.completion);
                  const inputMods = orModalities(m.architecture?.input_modalities);
                  const outputMods = orModalities(m.architecture?.output_modalities);
                  const effort = orSupportsEffort(m);

                  return (
                    <tr
                      key={m.id}
                      className="border-b border-border/50 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
                    >
                      <td className="px-2 py-1.5">
                        <span className="truncate font-medium">{m.name}</span>
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {m.id}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right text-[12px] text-muted-foreground">
                        {fmtPrice(promptPrice)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[12px] text-muted-foreground">
                        {fmtPrice(completionPrice)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[12px] text-muted-foreground">
                        {fmtCtx(m.context_length)}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex justify-center">
                          <ModalityBadges modalities={inputMods} fixedSlots />
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex justify-center">
                          <ModalityBadges modalities={outputMods} fixedSlots />
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {effort && (
                          <span className="rounded bg-violet-500/10 px-1 py-0.5 text-[9px] font-medium text-violet-600 dark:text-violet-400">
                            reasoning
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {exists ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Check className="size-3.5" />
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onAdd(orToProviderModel(m))}
                            className="inline-flex items-center gap-1 rounded-md bg-foreground px-2.5 py-1 text-[12px] font-medium text-background transition-opacity hover:opacity-90"
                          >
                            <Plus className="size-3" />
                            Add
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {!loading && !error && results.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No models found for "{query}"
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
