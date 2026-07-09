import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  useProviderStore,
  activeModelOf,
  type LLMProvider,
  type LLMProviderInput,
  type ProviderKind,
  type ProviderModel,
} from "@/stores/providerStore";
import { cn } from "@/lib/utils";

function newModelId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
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
      <label className="text-xs text-muted-foreground">{label}</label>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? undefined : Number(e.target.value))
        }
        className="w-full rounded-md border px-2 py-1 text-sm"
        placeholder={placeholder}
        step={step}
      />
    </div>
  );
}

const KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek (Anthropic compat)",
  openrouter: "OpenRouter",
  openai: "OpenAI Compatible",
};

function ProviderForm({
  provider,
  onSave,
  onCancel,
}: {
  provider?: LLMProvider;
  onSave: () => void;
  onCancel: () => void;
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
      // Pre-models[] provider — lift the flat fields into one row.
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
  const [activeModelId, setActiveModelId] = useState<string | undefined>(
    provider?.activeModelId,
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const patchModel = (id: string, patch: Partial<ProviderModel>): void =>
    setModels((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    );

  const handleSave = async () => {
    const clean = models
      .map((m) => ({ ...m, name: m.name.trim() }))
      .filter((m) => m.name);
    if (!name.trim() || !baseURL.trim() || clean.length === 0) {
      setError("Name, Base URL, and at least one model are required");
      return;
    }
    const activeId = clean.some((m) => m.id === activeModelId)
      ? activeModelId
      : clean[0].id;
    const active = clean.find((m) => m.id === activeId)!;

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
      if (isEdit) {
        await update(provider!.id, input);
      } else {
        await add(input);
      }
      onSave();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <h3 className="text-lg font-semibold">
        {isEdit ? "Edit Provider" : "Add Provider"}
      </h3>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="grid gap-3">
        <div>
          <label className="text-sm font-medium">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
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
              if (!isEdit) {
                if (k === "anthropic") setBaseURL("https://api.anthropic.com");
                else if (k === "deepseek")
                  setBaseURL("https://api.deepseek.com/anthropic");
                else if (k === "openrouter")
                  setBaseURL("https://openrouter.ai/api/v1");
                else setBaseURL("http://localhost:8080/v1");
              }
            }}
            className="w-full rounded-md border px-3 py-2 text-sm"
          >
            <option value="anthropic">Anthropic</option>
            <option value="deepseek">DeepSeek (Anthropic compat)</option>
            <option value="openrouter">OpenRouter</option>
            <option value="openai">OpenAI Compatible</option>
          </select>
        </div>
        <div>
          <label className="text-sm font-medium">Base URL</label>
          <input
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
            placeholder="https://api.anthropic.com"
          />
        </div>
        <div>
          <label className="text-sm font-medium">
            API Key{isEdit ? " (leave empty to keep current)" : ""}
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
            placeholder="sk-..."
          />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-sm font-medium">Models</label>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setModels((prev) => [...prev, { id: newModelId(), name: "" }])
              }
            >
              Add model
            </Button>
          </div>
          <div className="space-y-2">
            {models.map((m) => (
              <div key={m.id} className="rounded-md border p-2">
                <div className="mb-2 flex items-center gap-2">
                  <input
                    type="radio"
                    name="active-model"
                    title="Use this model"
                    checked={
                      (models.some((x) => x.id === activeModelId)
                        ? activeModelId
                        : models[0]?.id) === m.id
                    }
                    onChange={() => setActiveModelId(m.id)}
                  />
                  <input
                    value={m.name}
                    onChange={(e) => patchModel(m.id, { name: e.target.value })}
                    className="flex-1 rounded-md border px-2 py-1 font-mono text-sm"
                    placeholder="model id (e.g. anthropic/claude-sonnet-4)"
                  />
                  <input
                    value={m.label ?? ""}
                    onChange={(e) =>
                      patchModel(m.id, { label: e.target.value || undefined })
                    }
                    className="w-36 rounded-md border px-2 py-1 text-sm"
                    placeholder="Label"
                  />
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      setModels((prev) => prev.filter((x) => x.id !== m.id))
                    }
                    disabled={models.length === 1}
                  >
                    ✕
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
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
                    onChange={(v) => patchModel(m.id, { maxOutputTokens: v })}
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
                  <label className="text-xs text-muted-foreground">
                    Base URL override (optional — inherits the provider URL)
                  </label>
                  <input
                    value={m.baseURL ?? ""}
                    onChange={(e) =>
                      patchModel(m.id, { baseURL: e.target.value || undefined })
                    }
                    className="w-full rounded-md border px-2 py-1 text-sm"
                    placeholder={baseURL || "https://…"}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ProviderSettings({
  className,
}: {
  className?: string;
}): JSX.Element {
  const { providers, loading, error, load, remove, setActive } =
    useProviderStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <div className="p-6 text-muted-foreground">Loading providers...</div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">LLM Providers</h2>
        <Button onClick={() => setAdding(true)} disabled={adding}>
          Add Provider
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {providers.length === 0 && !loading && (
        <p className="text-muted-foreground">
          No providers. Click "Add Provider" to configure one.
        </p>
      )}

      <div className="space-y-2">
        {providers.map((p) => (
          <div
            key={p.id}
            className={cn(
              "flex items-center justify-between rounded-lg border p-3",
              p.isActive && "border-primary bg-primary/5",
            )}
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  {KIND_LABELS[p.kind]}
                </span>
                {p.isActive && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                    Active
                  </span>
                )}
              </div>
              <div className="text-sm text-muted-foreground">
                {activeModelOf(p)?.label || activeModelOf(p)?.name || p.model}
                {p.models && p.models.length > 1
                  ? ` · ${p.models.length} models`
                  : ""}{" "}
                @ {p.baseURL}
              </div>
              {p.apiKey && (
                <div className="text-xs text-green-600">Key configured</div>
              )}
              {!p.apiKey && (
                <div className="text-xs text-orange-500">No API key</div>
              )}
            </div>
            <div className="flex gap-1">
              {!p.isActive && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setActive(p.id)}
                >
                  Activate
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditingId(p.id)}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => remove(p.id)}
                disabled={p.isActive}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>

      {editingId && (
        <ProviderForm
          provider={providers.find((p) => p.id === editingId)!}
          onSave={() => setEditingId(null)}
          onCancel={() => setEditingId(null)}
        />
      )}

      {adding && (
        <ProviderForm
          onSave={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}
