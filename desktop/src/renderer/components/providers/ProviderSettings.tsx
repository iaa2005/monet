import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  useProviderStore,
  type LLMProvider,
  type LLMProviderInput,
  type ProviderKind,
} from "@/stores/providerStore";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek (Anthropic compat)",
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
  const [model, setModel] = useState(provider?.model ?? "");
  const [maxTokens, setMaxTokens] = useState(String(provider?.maxTokens ?? 16000));
  const [contextLimit, setContextLimit] = useState(
    String(provider?.contextLimit ?? 200_000),
  );
  const [temperature, setTemperature] = useState(
    provider?.temperature != null ? String(provider.temperature) : "",
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim() || !baseURL.trim() || !model.trim()) {
      setError("Name, Base URL, and Model are required");
      return;
    }

    setSaving(true);
    setError("");

    const input: LLMProviderInput = {
      name: name.trim(),
      kind,
      baseURL: baseURL.trim(),
      apiKey: apiKey || provider?.apiKey || "",
      model: model.trim(),
      isActive: provider?.isActive ?? false,
      maxTokens: parseInt(maxTokens, 10) || 16000,
      contextLimit: parseInt(contextLimit, 10) || 200_000,
      temperature: temperature.trim()
        ? parseFloat(temperature)
        : undefined,
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
                else setBaseURL("http://localhost:8080/v1");
              }
            }}
            className="w-full rounded-md border px-3 py-2 text-sm"
          >
            <option value="anthropic">Anthropic</option>
            <option value="deepseek">DeepSeek (Anthropic compat)</option>
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
          <label className="text-sm font-medium">Model</label>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
            placeholder="claude-sonnet-4-20250514"
          />
        </div>
        <div>
          <label className="text-sm font-medium">Max Tokens</label>
          <input
            type="number"
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
            placeholder="16000"
            min={1}
            max={384000}
          />
        </div>
        <div>
          <label className="text-sm font-medium">
            Temperature{" "}
            <span className="text-muted-foreground">(optional)</span>
          </label>
          <input
            type="number"
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
            placeholder="default"
            min={0}
            max={2}
            step={0.1}
          />
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
                {p.model} @ {p.baseURL}
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
