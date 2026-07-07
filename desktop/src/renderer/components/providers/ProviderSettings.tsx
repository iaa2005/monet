import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useProviderStore, type LLMProvider, type LLMProviderInput, type ProviderKind } from '@/stores/providerStore'
import { cn } from '@/lib/utils'

const KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek (Anthropic compat)',
  openai: 'OpenAI Compatible',
}

interface ProviderFormProps {
  provider?: LLMProvider
  onSave: () => void
  onCancel: () => void
}

export function ProviderForm({ provider, onSave, onCancel }: ProviderFormProps): JSX.Element {
  const { add, update } = useProviderStore()
  const isEdit = !!provider

  const [name, setName] = useState(provider?.name ?? '')
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? 'anthropic')
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? '')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(provider?.model ?? '')
  const [error, setError] = useState('')

  const handleSave = (): void => {
    if (!name.trim() || !baseURL.trim() || !model.trim()) {
      setError('Name, Base URL, and Model are required')
      return
    }

    const input: LLMProviderInput = {
      name: name.trim(),
      kind,
      baseURL: baseURL.trim(),
      apiKey: apiKey || provider?.apiKey || '',
      model: model.trim(),
      isActive: provider?.isActive ?? false,
    }

    if (isEdit) {
      update(provider!.id, input)
    } else {
      add(input)
    }

    onSave()
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <h3 className="text-lg font-semibold">{isEdit ? 'Edit Provider' : 'Add Provider'}</h3>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-3">
        <div>
          <label className="text-sm font-medium">Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="My Provider"
          />
        </div>

        <div>
          <label className="text-sm font-medium">Type</label>
          <select
            value={kind}
            onChange={e => {
              const k = e.target.value as ProviderKind
              setKind(k)
              // Set defaults based on kind
              if (!isEdit) {
                if (k === 'anthropic') setBaseURL('https://api.anthropic.com')
                else if (k === 'deepseek') setBaseURL('https://api.deepseek.com/anthropic')
                else setBaseURL('http://localhost:8080/v1')
              }
            }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="anthropic">Anthropic</option>
            <option value="deepseek">DeepSeek (Anthropic compat)</option>
            <option value="openai">OpenAI Compatible</option>
          </select>
        </div>

        <div>
          <label className="text-sm font-medium">Base URL</label>
          <input
            type="text"
            value={baseURL}
            onChange={e => setBaseURL(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="https://api.anthropic.com"
          />
        </div>

        <div>
          <label className="text-sm font-medium">
            API Key {isEdit && '(leave empty to keep current)'}
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="sk-..."
          />
        </div>

        <div>
          <label className="text-sm font-medium">Model</label>
          <input
            type="text"
            value={model}
            onChange={e => setModel(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="claude-sonnet-4-20250514"
          />
        </div>
      </div>

      <div className="flex gap-2">
        <Button onClick={handleSave}>Save</Button>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

interface ProviderSettingsProps {
  className?: string
}

export function ProviderSettings({ className }: ProviderSettingsProps): JSX.Element {
  const { providers, remove, setActive } = useProviderStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">LLM Providers</h2>
        <Button onClick={() => setAdding(true)} disabled={adding}>
          Add Provider
        </Button>
      </div>

      {/* Provider list */}
      <div className="space-y-2">
        {providers.map(p => (
          <div
            key={p.id}
            className={cn(
              'flex items-center justify-between rounded-lg border p-3',
              p.isActive && 'border-primary bg-primary/5',
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
            </div>

            <div className="flex gap-1">
              {!p.isActive && (
                <Button size="sm" variant="outline" onClick={() => setActive(p.id)}>
                  Activate
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditingId(p.id)}>
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

      {/* Edit form */}
      {editingId && (
        <ProviderForm
          provider={providers.find(p => p.id === editingId)!}
          onSave={() => setEditingId(null)}
          onCancel={() => setEditingId(null)}
        />
      )}

      {/* Add form */}
      {adding && (
        <ProviderForm
          onSave={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  )
}
