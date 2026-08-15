/**
 * Provider Settings — LLM providers, each with a list of models that carry
 * their own parameters (context, input/output budgets, temperature, per-model
 * Base URL, input modalities, visibility in the composer picker).
 *
 * Visual language matches the rest of the app: bg-card rounded-xl rows,
 * ghost icon buttons, a modal editor like the Connectors panel.
 */

import { useEffect, useState } from "react";
import {
  Boxes,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "@/components/icons/hg";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import {
  useProviderStore,
  activeModelOf,
  type LLMProvider,
  type LLMProviderInput,
  type ProviderKind,
  type ProviderModel,
} from "@/stores/providerStore";
import { ModalityBadges, ModalityToggles } from "./ModalityBadges";
import { OpenRouterBrowser } from "./OpenRouterBrowser";
import { CatalogBrowser } from "./CatalogBrowser";
import type { ORKeyInfo } from "@/types/electron";
import { Select } from "@/components/ui/select";
import { PickCard } from "@/components/settings/PickCard";
import { SectionHeader } from "@/components/settings/SectionTitle";

const KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek (Anthropic compat)",
  openrouter: "OpenRouter",
  openai: "OpenAI Compatible",
};

const KIND_URLS: Record<ProviderKind, string> = {
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com/anthropic",
  openrouter: "https://openrouter.ai/api/v1",
  openai: "http://localhost:8080/v1",
};

const inputCls =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground/20";
const inputXs =
  "w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none focus:ring-1 focus:ring-foreground/20";
const ghostBtn =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground dark:hover:bg-white/[0.08]";

function newModelId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function fmtK(n?: number): string {
  if (!n) return "—";
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** The model's page on openrouter.ai (the id IS the URL path). */
function openORModelPage(modelName: string): void {
  void window.electronAPI?.shell.openExternal(
    `https://openrouter.ai/${modelName}`,
  );
}

function NumField({
  label,
  value,
  onChange,
  placeholder,
  step,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
  step?: number;
}): JSX.Element {
  return (
    <div>
      <label className="text-[11px] text-muted-foreground">{label}</label>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? undefined : Number(e.target.value))
        }
        className={inputXs}
        placeholder={placeholder}
        step={step}
      />
    </div>
  );
}

// ─── Modal editor ─────────────────────────────────────────────────────────

function ProviderModal({
  provider,
  onClose,
}: {
  provider?: LLMProvider;
  onClose: () => void;
}): JSX.Element {
  const { add, update } = useProviderStore();
  const isEdit = !!provider;

  const [name, setName] = useState(provider?.name ?? "");
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? "anthropic");
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? "");
  const [apiKey, setApiKey] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [discoverNote, setDiscoverNote] = useState<string | null>(null);

  /**
   * Ask the endpoint what it has. This is the only way to know a LOCAL
   * server's models — Ollama / LM Studio / llama.cpp all answer /v1/models.
   *
   * Additive on purpose: models already configured (with their context and
   * token settings) are kept, and only names not present yet are appended. A
   * discovery call must never quietly discard what the user set up.
   */
  const discoverModels = async (): Promise<void> => {
    setDiscovering(true);
    setDiscoverNote(null);
    try {
      const key = apiKey || (isEdit ? (provider?.apiKey ?? "") : "");
      const r = await window.electronAPI?.providers.fetchModels(baseURL.trim(), key);
      if (!r?.ok) {
        setDiscoverNote(r?.error ? `Couldn't load models: ${r.error}` : "Couldn't load models.");
        return;
      }
      const found = r.models ?? [];
      if (found.length === 0) {
        setDiscoverNote("The endpoint answered, but listed no models.");
        return;
      }
      let added = 0;
      setModels((prev) => {
        const have = new Set(prev.map((m: ProviderModel) => m.name).filter(Boolean));
        const fresh = found
          .filter((m: { name: string }) => !have.has(m.name))
          .map((m: { name: string }) => ({ id: newModelId(), name: m.name }));
        added = fresh.length;
        // Drop a single blank row left over from "Add model".
        const kept = prev.filter((m: ProviderModel) => m.name.trim());
        return [...kept, ...fresh];
      });
      setDiscoverNote(
        added === 0
          ? `${found.length} model(s) found — all already listed.`
          : `Added ${added} of ${found.length} model(s).`,
      );
    } finally {
      setDiscovering(false);
    }
  };

  // Editing a provider starts from its models; adding one starts from a blank
  // row. There was a third branch — build a row out of the record's flat
  // `model`/`contextLimit`/`maxTokens` — for a stored provider with no
  // models[], which is a shape that no longer exists (and whose flat fields
  // were only ever a copy this form itself wrote back).
  const [models, setModels] = useState<ProviderModel[]>(() =>
    provider?.models?.length
      ? provider.models.map((m) => ({ ...m }))
      : [{ id: newModelId(), name: "" }],
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  // OpenRouter rows keep routing behind a per-model "Advanced" disclosure —
  // the default experience is "added it, done", no extra inputs.
  const [advancedModels, setAdvancedModels] = useState<Set<string>>(new Set());

  const patchModel = (id: string, patch: Partial<ProviderModel>): void =>
    setModels((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const handleSave = async (): Promise<void> => {
    const clean = models
      .map((m) => ({ ...m, name: m.name.trim() }))
      .filter((m) => m.name);
    if (!name.trim() || !baseURL.trim() || clean.length === 0) {
      setError("Name, Base URL, and at least one model are required");
      return;
    }
    const activeId = clean[0].id;

    setSaving(true);
    setError("");
    const input: LLMProviderInput = {
      name: name.trim(),
      kind,
      baseURL: baseURL.trim(),
      apiKey: apiKey || provider?.apiKey || "",
      isActive: provider?.isActive ?? false,
      models: clean,
      activeModelId: activeId,
    };
    try {
      if (isEdit) await update(provider!.id, input);
      else await add(input);
      onClose();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      // Only a click on the backdrop ITSELF closes. It used to close on any
      // click that bubbled up here, which meant a child modal rendered inside
      // this element — the catalog browser is — dismissed the whole editor on
      // every click unless it remembered to stop propagation. That is a trap
      // for the next one too, so the check lives here rather than in each child.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pb-3 pt-5">
          <h3 className="text-base font-semibold">
            {isEdit ? "Edit provider" : "Add provider"}
          </h3>
          <button type="button" onClick={onClose} className={ghostBtn}>
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          {error && (
            <div className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputCls}
                placeholder="My Provider"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Type</label>
              <Select
                ariaLabel="Provider kind"
                value={kind}
                onChange={(v) => {
                  const k = v as ProviderKind;
                  setKind(k);
                  if (!isEdit) setBaseURL(KIND_URLS[k]);
                }}
                className="w-full justify-between py-2 text-sm"
                options={(Object.keys(KIND_LABELS) as ProviderKind[]).map((k) => ({
                  value: k,
                  label: KIND_LABELS[k],
                }))}
              />
            </div>
          </div>

          <div className="mt-3">
            <label className="text-sm font-medium">Base URL</label>
            <input
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              className={cn(inputCls, "font-mono text-xs")}
              placeholder="https://api.example.com/v1"
            />
          </div>
          <div className="mt-3">
            <label className="text-sm font-medium">
              API Key
              {isEdit && (
                <span className="text-muted-foreground">
                  {" "}
                  — leave empty to keep current
                </span>
              )}
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className={inputCls}
              placeholder="sk-…"
            />
          </div>

          <div className="mb-1.5 mt-5">
            <span className="text-sm font-medium">Models</span>
          </div>

          <div className="space-y-2 pb-3">
            {models.map((m) => {
              return (
                <div
                  key={m.id}
                  className="rounded-xl border border-border p-3"
                >
                  <div className="flex items-center gap-2">
                    <input
                      value={m.name}
                      onChange={(e) =>
                        patchModel(m.id, { name: e.target.value })
                      }
                      className={cn(inputXs, "flex-1 font-mono")}
                      placeholder="model id (e.g. anthropic/claude-sonnet-4)"
                    />
                    <input
                      value={m.label ?? ""}
                      onChange={(e) =>
                        patchModel(m.id, { label: e.target.value || undefined })
                      }
                      className={cn(inputXs, "w-32")}
                      placeholder="Label"
                    />
                    <button
                      type="button"
                      title={
                        m.hidden
                          ? "Hidden from the model picker — click to show"
                          : "Shown in the model picker — click to hide"
                      }
                      onClick={() => patchModel(m.id, { hidden: !m.hidden })}
                      className={ghostBtn}
                    >
                      {m.hidden ? (
                        <EyeOff className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      title="Remove model"
                      onClick={() =>
                        setModels((prev) => prev.filter((x) => x.id !== m.id))
                      }
                      disabled={models.length === 1}
                      className={cn(
                        ghostBtn,
                        "hover:bg-destructive/10 hover:text-destructive",
                      )}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>

                  {kind !== "openrouter" && (
                    <>
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">
                          Accepts
                        </span>
                        <ModalityToggles
                          value={m.modalities}
                          onChange={(next) =>
                            patchModel(m.id, { modalities: next })
                          }
                        />
                      </div>

                      <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
                        <Switch
                          className="h-5 w-9 [&>span]:size-4"
                          checked={m.supportsEffort ?? false}
                          onChange={(v) =>
                            patchModel(m.id, { supportsEffort: v })
                          }
                        />
                        Supports reasoning effort — shows the composer's
                        Faster↔Smarter control
                      </label>

                      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                        <NumField
                          label="Context Length"
                          value={m.contextLength}
                          onChange={(v) => patchModel(m.id, { contextLength: v })}
                          placeholder="200000"
                        />
                        <NumField
                          label="Max Input Tokens"
                          value={m.maxInputTokens}
                          onChange={(v) => patchModel(m.id, { maxInputTokens: v })}
                          placeholder="optional"
                        />
                        <NumField
                          label="Max Output Tokens"
                          value={m.maxOutputTokens}
                          onChange={(v) =>
                            patchModel(m.id, { maxOutputTokens: v })
                          }
                          placeholder="16000"
                        />
                        <NumField
                          label="Temperature"
                          value={m.temperature}
                          onChange={(v) => patchModel(m.id, { temperature: v })}
                          placeholder="default"
                          step={0.1}
                        />
                      </div>

                      <div className="mt-2">
                        <label className="text-[11px] text-muted-foreground">
                          Base URL override (inherits the provider URL)
                        </label>
                        <input
                          value={m.baseURL ?? ""}
                          onChange={(e) =>
                            patchModel(m.id, {
                              baseURL: e.target.value || undefined,
                            })
                          }
                          className={cn(inputXs, "font-mono")}
                          placeholder={baseURL || "https://…"}
                        />
                      </div>
                    </>
                  )}

                  {kind === "openrouter" && (
                    <>
                      {/* Everything below came from the OpenRouter catalog —
                          read-only by design: "added it, done". */}
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <ModalityBadges modalities={m.modalities} />
                        {m.supportsEffort && (
                          <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">
                            reasoning
                          </span>
                        )}
                        {m.contextLength ? (
                          <span>{fmtK(m.contextLength)} ctx</span>
                        ) : null}
                        {m.maxOutputTokens ? (
                          <span>{fmtK(m.maxOutputTokens)} out</span>
                        ) : null}
                        {m.pricing && (
                          <span>
                            ${m.pricing.promptPer1M} in / $
                            {m.pricing.completionPer1M} out per 1M
                          </span>
                        )}
                        <button
                          type="button"
                          title={`Open on openrouter.ai/${m.name}`}
                          onClick={() => openORModelPage(m.name)}
                          className="inline-flex items-center gap-1 text-link transition-opacity hover:underline"
                        >
                          openrouter.ai
                          <ExternalLink className="size-3" />
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          setAdvancedModels((prev) => {
                            const next = new Set(prev);
                            if (next.has(m.id)) next.delete(m.id);
                            else next.add(m.id);
                            return next;
                          })
                        }
                        className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ChevronDown
                          className={cn(
                            "size-3 transition-transform",
                            !advancedModels.has(m.id) && "-rotate-90",
                          )}
                        />
                        Advanced routing
                      </button>

                      {advancedModels.has(m.id) && (
                        <div className="mt-1.5 space-y-1.5 rounded-lg border border-border/60 p-2">
                          <div>
                            <label className="text-[11px] text-muted-foreground">
                              Provider companies — SLUGS, comma-separated
                            </label>
                            <input
                              value={(
                                m.routing?.only ??
                                m.routing?.providers ??
                                []
                              ).join(", ")}
                              onChange={(e) => {
                                const list = e.target.value
                                  .split(",")
                                  .map((x) => x.trim())
                                  .filter(Boolean);
                                const pinned = !!m.routing?.only;
                                patchModel(m.id, {
                                  routing: {
                                    ...m.routing,
                                    only: pinned ? list : undefined,
                                    providers: pinned ? undefined : list,
                                  },
                                });
                              }}
                              className={cn(inputXs, "font-mono")}
                              /* Lowercase slugs, as the API spells them. The old
                                 placeholder said "Anthropic, Google" — display
                                 names, which taught the wrong format. */
                              placeholder="novita, baidu, deepinfra (empty = automatic)"
                            />
                          </div>
                          {/*
                            ONE choice, not two switches. Measured against the
                            live API, `only` and `allow_fallbacks` are not
                            independent — they produce three behaviours between
                            them, and the fourth combination is a duplicate:

                              only:[x] + fallbacks on   → 404 (only is a HARD
                              only:[x] + fallbacks off  → 404  filter; the flag
                                                               changes nothing)
                              order:[x] + fallbacks on  → served by anyone
                              order:[x] + fallbacks off → 404 — i.e. "only"

                            So: no list, a preference, or a limit.
                          */}
                          <div className="flex gap-1">
                            {(
                              [
                                ["auto", "Automatic"],
                                ["prefer", "Prefer these"],
                                ["only", "Only these"],
                              ] as const
                            ).map(([mode, label]) => {
                              const list =
                                m.routing?.only ?? m.routing?.providers ?? [];
                              const current = m.routing?.only
                                ? "only"
                                : list.length
                                  ? "prefer"
                                  : "auto";
                              return (
                                <button
                                  key={mode}
                                  type="button"
                                  onClick={() =>
                                    patchModel(m.id, {
                                      routing: {
                                        ...m.routing,
                                        only: mode === "only" ? list : undefined,
                                        providers:
                                          mode === "prefer" ? list : undefined,
                                        // Off in "only" mode because it cannot
                                        // matter there; on for a preference,
                                        // which is what a preference means.
                                        allowFallbacks: mode !== "only",
                                      },
                                    })
                                  }
                                  className={cn(
                                    "rounded-md border px-2 py-1 text-[11px] transition-colors",
                                    current === mode
                                      ? "border-brand/40 bg-brand/[0.08] text-foreground"
                                      : "border-border text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                          <p className="text-[10px] leading-relaxed text-muted-foreground/80">
                            {m.routing?.only
                              ? "Only the companies listed may serve this model; anything else is refused with a 404 that lists the valid slugs. A typo cannot pass silently."
                              : (m.routing?.providers?.length ?? 0) > 0
                                ? "Tried first, then anyone. A misspelled slug is IGNORED WITHOUT COMPLAINT here — the request simply goes elsewhere, so check the company named in the reply."
                                : "OpenRouter picks the company. It names the one it used in every reply."}
                          </p>
                          <div className="flex items-center justify-between gap-2">
                            <label className="text-[11px] text-muted-foreground">
                              Service tier
                            </label>
                            <Select
                              ariaLabel="Service tier"
                              value={m.routing?.serviceTier ?? ""}
                              onChange={(v) =>
                                patchModel(m.id, {
                                  routing: {
                                    ...m.routing,
                                    serviceTier:
                                      v === "flex" || v === "priority" ? v : undefined,
                                  },
                                })
                              }
                              className="w-36 justify-between"
                              options={[
                                { value: "", label: "Default" },
                                { value: "flex", label: "Flex — half price" },
                                { value: "priority", label: "Priority" },
                              ]}
                            />
                          </div>
                          <p className="text-[10px] leading-relaxed text-muted-foreground/80">
                            Flex is half price and slower, and only some OpenAI,
                            Google and xAI models have it. The reply does not
                            confirm a tier — OpenRouter echoes{" "}
                            <code>service_tier: null</code> either way — so the
                            bill is the only proof. A pinned company IS
                            confirmed: every reply names who served it.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}

            <button
              type="button"
              onClick={() =>
                setModels((prev) => [...prev, { id: newModelId(), name: "" }])
              }
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-border px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-black/[0.03] hover:text-foreground dark:hover:bg-white/[0.04]"
            >
              <Plus className="size-4" />
              Add model
            </button>
            {kind !== "openrouter" && (
              <button
                type="button"
                onClick={() => setShowCatalog(true)}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-border px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-black/[0.03] hover:text-foreground dark:hover:bg-white/[0.04]"
              >
                <Search className="size-4" />
                Browse the model catalog
              </button>
            )}
            {kind !== "openrouter" && (
              <button
                type="button"
                disabled={discovering || !baseURL.trim()}
                onClick={() => void discoverModels()}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-border px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-black/[0.03] hover:text-foreground disabled:opacity-50 dark:hover:bg-white/[0.04]"
              >
                {discovering ? "Loading…" : "Load models from this endpoint"}
              </button>
            )}
            {discoverNote && (
              <p className="text-xs text-muted-foreground">{discoverNote}</p>
            )}
            {kind === "openrouter" && (apiKey || (isEdit && provider?.apiKey)) && (
              <button
                type="button"
                onClick={() => setShowBrowser(true)}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-border px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-black/[0.03] hover:text-foreground dark:hover:bg-white/[0.04]"
              >
                <Search className="size-4" />
                Browse OpenRouter models
              </button>
            )}
            {kind === "openrouter" && !apiKey && !(isEdit && provider?.apiKey) && (
              <p className="text-center text-[11px] text-muted-foreground">
                Enter an API key to enable model browsing
              </p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-foreground px-3.5 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {showCatalog && (
        <CatalogBrowser
          kind={kind}
          baseURL={baseURL}
          existingNames={new Set(models.map((m) => m.name))}
          onAdd={(m) => setModels((prev) => [...prev, m])}
          onClose={() => setShowCatalog(false)}
        />
      )}

      {showBrowser && kind === "openrouter" && (
        <OpenRouterBrowser
          apiKey={apiKey || provider?.apiKey || ""}
          existingNames={new Set(models.map((m) => m.name))}
          onAdd={(m) => {
            setModels((prev) => [...prev, m]);
          }}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </div>
  );
}

// ─── Credits Widget ───────────────────────────────────────────────────────

function CreditsWidget({ apiKey }: { apiKey: string }): JSX.Element {
  const [info, setInfo] = useState<ORKeyInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchInfo = async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const res = await window.electronAPI.providers.orKeyInfo(apiKey);
      if (res.ok && res.info) setInfo(res.info as ORKeyInfo);
      else setError(res.error || "Failed");
    } catch (err) {
      setError(String(err));
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  if (loading) {
    return (
      <div className="mt-1.5 pl-3.5 text-[11px] text-muted-foreground">
        Loading credits…
      </div>
    );
  }
  if (error || !info) {
    return (
      <div className="mt-1.5 flex items-center gap-2 pl-3.5">
        <span className="text-[11px] text-muted-foreground">
          Credits unavailable
        </span>
        <button
          type="button"
          onClick={fetchInfo}
          className={ghostBtn}
          title="Retry"
        >
          <RefreshCw className="size-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1.5 flex items-center gap-2 pl-3.5 text-[11px]">
      {info.isFreeTier && (
        <span className="rounded-full bg-green-bg px-1.5 py-0.5 text-[10px] font-medium text-green-text">
          free tier
        </span>
      )}
      {info.balance != null ? (
        <span className="font-medium text-foreground">
          ${info.balance.toFixed(2)} balance
        </span>
      ) : (
        <span className="text-muted-foreground">balance unknown</span>
      )}
      {info.totalUsage != null && (
        <span className="text-muted-foreground/70">
          · ${info.totalUsage.toFixed(2)} spent
        </span>
      )}
      {info.keyUsage != null && info.keyUsage > 0 && (
        <span
          className="text-muted-foreground/70"
          title="Spent through this API key"
        >
          · ${info.keyUsage.toFixed(2)} this key
        </span>
      )}
      {info.keyLimit != null && (
        <span
          className="text-muted-foreground/70"
          title="This key's spending cap"
        >
          · cap ${info.keyLimit.toFixed(2)}
        </span>
      )}
      <button
        type="button"
        onClick={fetchInfo}
        className={ghostBtn}
        title="Refresh balance"
      >
        <RefreshCw className="size-3" />
      </button>
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────

export function ProviderSettings({
  className,
}: {
  className?: string;
}): JSX.Element {
  const { providers, loading, error, load, remove, setActive, setActiveModel } =
    useProviderStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Loading providers…
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <SectionHeader
          className="mb-0"
          title="Providers"
          description="Endpoints, keys and per-model parameters."
        />
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          <Plus className="size-3.5" />
          Add provider
        </button>
      </div>

      {error && (
        <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {providers.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No providers yet — add one to start chatting.
        </p>
      )}

      <div className="space-y-2">
        {providers.map((p) => {
          const current = activeModelOf(p);
          return (
            <PickCard
              key={p.id}
              icon={Boxes}
              title={p.name}
              badge={
                <>
                  <span className="text-[11px] text-muted-foreground">
                    {KIND_LABELS[p.kind]}
                  </span>
                  {!p.apiKey && (
                    <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                      no key
                    </span>
                  )}
                </>
              }
              description={
                <span className="block truncate font-mono text-[11px]">
                  {p.baseURL}
                </span>
              }
              selected={p.isActive}
              onClick={p.isActive ? undefined : () => setActive(p.id)}
              trailing={
                <>
                <button
                  type="button"
                  title="Edit"
                  onClick={() => setEditingId(p.id)}
                  className={ghostBtn}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  title={p.isActive ? "Can't delete the active provider" : "Delete"}
                  onClick={() => remove(p.id)}
                  disabled={p.isActive}
                  className={cn(
                    ghostBtn,
                    "hover:bg-destructive/10 hover:text-destructive",
                  )}
                >
                  <Trash2 className="size-3.5" />
                </button>
                </>
              }
            >
              {p.kind === "openrouter" && p.apiKey && (
                <CreditsWidget apiKey={p.apiKey} />
              )}

              {p.models && p.models.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {p.models.map((m) => {
                    const inUse = m.id === (current?.id ?? "");
                    return (
                      <button
                        type="button"
                        key={m.id}
                        onClick={() => setActiveModel(p.id, m.id)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
                          inUse && "bg-black/[0.04] dark:bg-white/[0.06]",
                          m.hidden && "opacity-50",
                        )}
                      >
                        <span className="truncate">{m.label || m.name}</span>
                        {p.kind === "openrouter" && (
                          // Not a <button>: the row itself is one (nested
                          // buttons are invalid HTML — React logs an error).
                          <span
                            role="link"
                            tabIndex={0}
                            title={`Open on openrouter.ai/${m.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              openORModelPage(m.name);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.stopPropagation();
                                openORModelPage(m.name);
                              }
                            }}
                            className="shrink-0 cursor-pointer text-muted-foreground/60 transition-colors hover:text-link"
                          >
                            <ExternalLink className="size-3" />
                          </span>
                        )}
                        <ModalityBadges modalities={m.modalities} />
                        {m.hidden && (
                          <EyeOff className="size-3 text-muted-foreground/70" />
                        )}
                        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                          {fmtK(m.contextLength)} ctx
                          {m.pricing && (
                            <span className="text-muted-foreground/70">
                              {" · $"}
                              {m.pricing.promptPer1M}/
                              {m.pricing.completionPer1M}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </PickCard>
          );
        })}
      </div>

      {(adding || editingId) && (
        <ProviderModal
          provider={
            editingId
              ? providers.find((p) => p.id === editingId)
              : undefined
          }
          onClose={() => {
            setAdding(false);
            setEditingId(null);
          }}
        />
      )}
    </div>
  );
}
