/**
 * LLM Provider type definitions.
 *
 * A provider (endpoint + API key) can host SEVERAL models, each with its own
 * parameters — context length, max input/output tokens, temperature, and an
 * optional per-model Base URL override. The rest of the app never deals with
 * the hierarchy: resolveProvider() flattens the active model into the legacy
 * single-model fields (model / maxTokens / temperature / contextLimit).
 */

export type ProviderKind = 'anthropic' | 'deepseek' | 'openai' | 'openrouter'

/** What a model can accept as input. */
export type Modality = 'text' | 'image' | 'audio' | 'file' | 'video'

/** Reasoning-effort level the composer can request (null/absent = off).
 * Full OpenRouter/OpenAI-style set; adapters translate/clamp per provider. */
export type EffortLevel =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/** Best-effort guess at whether a model exposes a reasoning-effort knob, used
 * as the default when a model has no explicit supportsEffort flag. */
export function inferEffortSupport(kind: ProviderKind, model: string): boolean {
  const m = model.toLowerCase()
  if (/(reason|think|-r1\b|o1|o3|o4|gpt-5)/.test(m)) return true
  if (kind === 'anthropic') {
    if (m.includes('haiku')) return false
    return m.includes('opus') || m.includes('sonnet') || m.includes('claude')
  }
  return false
}

export interface ProviderModel {
  /** Internal id (uuid). */
  id: string
  /** Model id sent to the API, e.g. "deepseek-v4-pro", "anthropic/claude-sonnet-4". */
  name: string
  /** Optional display label (falls back to name). */
  label?: string
  /** Override the provider's Base URL for this model. */
  baseURL?: string
  /** Total context window in tokens. */
  contextLength?: number
  /** Max INPUT tokens (prompt budget). Compaction uses it when set. */
  maxInputTokens?: number
  /** Max OUTPUT tokens per request (max_tokens). */
  maxOutputTokens?: number
  temperature?: number
  /** Input modalities the model accepts. Defaults to ['text']. */
  modalities?: Modality[]
  /** Whether this model exposes a reasoning-effort knob. Unset → inferred. */
  supportsEffort?: boolean
  /** Hidden models don't show in the composer's model picker. */
  hidden?: boolean
}

export interface LLMProvider {
  id: string
  name: string
  kind: ProviderKind
  baseURL: string
  apiKey: string // encrypted at rest
  isActive: boolean
  /** The provider's models; the composer switches between them. */
  models: ProviderModel[]
  /** Which model is in use (falls back to the first). */
  activeModelId?: string

  // ── Effective values (resolved from the active model) ──────────────────
  // Kept as the single-model view the rest of the app consumes. Stored
  // configs from before the models[] era carry them directly; loadProviders
  // migrates those into models[].
  model: string
  maxTokens: number
  temperature?: number
  /** Context window size in tokens. */
  contextLimit: number
  /** Input-token budget (resolved from maxInputTokens; used by compaction). */
  inputLimit?: number
  /** Input modalities of the active model (resolved). */
  modalities?: Modality[]
  /** Whether the active model exposes a reasoning-effort knob (resolved). */
  supportsEffort?: boolean

  createdAt: string
  updatedAt: string
}

export type LLMProviderInput = Omit<LLMProvider, 'id' | 'createdAt' | 'updatedAt'>

/** Flatten the active model's parameters into the legacy single-model view. */
export function resolveProvider(p: LLMProvider): LLMProvider {
  const m =
    p.models?.find((x) => x.id === p.activeModelId) ?? p.models?.[0]
  if (!m) return p
  return {
    ...p,
    baseURL: m.baseURL?.trim() || p.baseURL,
    model: m.name,
    maxTokens: m.maxOutputTokens ?? p.maxTokens ?? 16000,
    temperature: m.temperature ?? p.temperature,
    contextLimit: m.contextLength ?? p.contextLimit ?? 200_000,
    inputLimit: m.maxInputTokens,
    modalities: m.modalities ?? ['text'],
    supportsEffort: m.supportsEffort ?? inferEffortSupport(p.kind, m.name),
  }
}

/** Preset providers with defaults (apiKey left empty for user to fill). */
export const PRESET_PROVIDERS: LLMProviderInput[] = [
  {
    name: 'Anthropic',
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    apiKey: '',
    model: 'claude-sonnet-4-20250514',
    isActive: true,
    maxTokens: 16000,
    contextLimit: 200_000,
    models: [
      {
        id: 'preset-claude-sonnet-4',
        name: 'claude-sonnet-4-20250514',
        label: 'Claude Sonnet 4',
        contextLength: 200_000,
        maxOutputTokens: 16000,
        modalities: ['text', 'image', 'file'],
      },
    ],
    activeModelId: 'preset-claude-sonnet-4',
  },
  {
    name: 'DeepSeek',
    kind: 'deepseek',
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKey: '',
    model: 'deepseek-v4-pro',
    isActive: false,
    maxTokens: 16000,
    contextLimit: 1_000_000,
    models: [
      {
        id: 'preset-deepseek-v4-pro',
        name: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        contextLength: 1_000_000,
        maxOutputTokens: 16000,
        modalities: ['text'],
      },
    ],
    activeModelId: 'preset-deepseek-v4-pro',
  },
  {
    name: 'OpenRouter',
    kind: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: '',
    // The auto-router picks a model per request; add concrete model ids
    // (e.g. anthropic/claude-sonnet-4) in Settings for agentic tool use.
    model: 'openrouter/auto',
    isActive: false,
    maxTokens: 16000,
    contextLimit: 200_000,
    models: [
      {
        id: 'preset-openrouter-auto',
        name: 'openrouter/auto',
        label: 'Auto Router',
        contextLength: 200_000,
        maxOutputTokens: 16000,
        modalities: ['text', 'image'],
      },
    ],
    activeModelId: 'preset-openrouter-auto',
  },
  {
    name: 'llama.cpp',
    kind: 'openai',
    baseURL: 'http://localhost:8080/v1',
    apiKey: '',
    model: 'local-model',
    isActive: false,
    maxTokens: 16000,
    contextLimit: 128_000,
    models: [
      {
        id: 'preset-local-model',
        name: 'local-model',
        label: 'Local model',
        contextLength: 128_000,
        maxOutputTokens: 16000,
      },
    ],
    activeModelId: 'preset-local-model',
  },
]
