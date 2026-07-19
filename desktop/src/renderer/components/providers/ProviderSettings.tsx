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
  ChevronDown,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
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
import type { ORKeyInfo } from "@/types/electron";

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
  const [models, setModels] = useState<ProviderModel[]>(() => {
    if (provider?.models?.length) return provider.models.map((m) => ({ ...m }));
    if (provider)
      return [
        {
          id: newModelId(),
          name: provider.model,
          contextLength: provider.contextLimit,
          maxOutputTokens: provider.maxTokens,
          temperature: provider.temperature,
        },
      ];
    return [{ id: newModelId(), name: "" }];
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
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
    const active = clean[0];

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
      // Legacy single-model view — main resolves from models[], but keep
      // these coherent for anything reading the raw record.
      model: active.name,
      maxTokens: active.maxOutputTokens ?? 16000,
      contextLimit: active.contextLength ?? 200_000,
      temperature: active.temperature,
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
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-2xl border border-border bg-card shadow-xl"
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
              <select
                value={kind}
                onChange={(e) => {
                  const k = e.target.value as ProviderKind;
                  setKind(k);
                  if (!isEdit) setBaseURL(KIND_URLS[k]);
                }}
                className={inputCls}
              >
                {(Object.keys(KIND_LABELS) as ProviderKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
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
                        <span className="text-muted-foreground/60">
                          auto from OpenRouter
                        </span>
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
                              Prefer specific providers (comma-separated)
                            </label>
                            <input
                              value={(m.routing?.providers ?? []).join(", ")}
                              onChange={(e) =>
                                patchModel(m.id, {
                                  routing: {
                                    providers: e.target.value
                                      .split(",")
                                      .map((s) => s.trim())
                                      .filter(Boolean),
                                    allowFallbacks:
                                      m.routing?.allowFallbacks ?? true,
                                  },
                                })
                              }
                              className={cn(inputXs, "font-mono")}
                              placeholder="e.g. Anthropic, Google (empty = auto)"
                            />
                          </div>
                          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
                            <Switch
                              className="h-5 w-9 [&>span]:size-4"
                              checked={m.routing?.allowFallbacks ?? true}
                              onChange={(v) =>
                                patchModel(m.id, {
                                  routing: {
                                    providers: m.routing?.providers ?? [],
                                    allowFallbacks: v,
                                  },
                                })
                              }
                            />
                            Allow fallback to other providers
                          </label>
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
        <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
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
        <div>
          <h2 className="text-base font-semibold">Providers</h2>
          <p className="text-[13px] text-muted-foreground">
            Endpoints, keys and per-model parameters.
          </p>
        </div>
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
            <div
              key={p.id}
              className="rounded-xl border border-border bg-card px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    p.isActive ? "bg-emerald-500" : "bg-muted-foreground/30",
                  )}
                />
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  {KIND_LABELS[p.kind]}
                </span>
                {!p.apiKey && (
                  <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                    no key
                  </span>
                )}
                <span className="flex-1" />
                {!p.isActive && (
                  <button
                    type="button"
                    title="Make active"
                    onClick={() => setActive(p.id)}
                    className={ghostBtn}
                  >
                    <Power className="size-3.5" />
                  </button>
                )}
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
              </div>

              <div className="mt-0.5 truncate pl-3.5 font-mono text-[11px] text-muted-foreground">
                {p.baseURL}
              </div>

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
            </div>
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
