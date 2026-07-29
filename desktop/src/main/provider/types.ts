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

/**
 * Best-effort input modalities for a model, used as the default when a model
 * carries no explicit `modalities` list.
 *
 * Why this exists: only the OpenRouter browser fills `modalities` in (from
 * `architecture.input_modalities`). Every model added by hand — which is every
 * model on a self-hosted gateway, a direct Anthropic key, or any OpenAI-
 * compatible endpoint — was created as `{ id, name }` and fell back to
 * `['text']`. The failure was silent in the worst way: the user attaches a
 * screenshot to GPT-4o, the app decides the model cannot see, and quietly
 * diverts the image to `stashUnsupported()`. No error, just a model answering
 * about a picture it was never shown.
 *
 * Kimi Code solves this with a per-model capability catalog (models.dev). This
 * is the same idea at the size that fits here: match on the model id, which is
 * the part that identifies what the model can do regardless of who serves it.
 *
 * Bias: when unsure, claim the modality. Over-claiming produces a loud API
 * error the user can act on; under-claiming produces the silent diversion
 * above. An explicit `modalities` on the model always wins over this guess.
 */
export function inferModalities(kind: ProviderKind, model: string): Modality[] {
  const m = model.toLowerCase()
  const mods: Modality[] = ['text']
  const add = (...xs: Modality[]): void => {
    for (const x of xs) if (!mods.includes(x)) mods.push(x)
  }

  // Anthropic: vision since Claude 3; PDF documents since 3.5. Claude 2 and
  // the instant models are text-only.
  const claude3Plus = /claude-(3|4|5|opus|sonnet|haiku)/.test(m)
  if (claude3Plus) {
    add('image')
    if (!/claude-3-(opus|sonnet|haiku)/.test(m)) add('file')
  }

  // OpenAI: 4o / 4-turbo / 4.1 / 5 and the o-series reasoning models see
  // images. gpt-3.5 and the base gpt-4 (0314/0613) do not.
  if (/gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|o1\b|o3\b|o4\b/.test(m))
    add('image')
  if (/gpt-4o-audio|gpt-audio/.test(m)) add('audio')

  // Google Gemini takes the widest set.
  if (/gemini/.test(m)) add('image', 'audio', 'video')

  // Moonshot Kimi — k2/k3 accept video, which is the point of the model.
  if (/\bkimi\b|moonshot|\bk2\b|\bk3\b/.test(m)) add('image', 'video')

  // Open-weight and other vision models, by the marker in their id.
  if (/-vl\b|\bvl-|vision|llava|pixtral|internvl|minicpm-v|moondream|molmo|\b4v\b|-v\d*b?\b.*vision/.test(m))
    add('image')
  if (/qwen.*(audio|omni)|-omni\b/.test(m)) add('image', 'audio')

  // A provider whose whole catalogue is one family: an Anthropic-kind endpoint
  // serving an unrecognised id is far more likely to be a Claude than not.
  if (kind === 'anthropic' && mods.length === 1) add('image')

  return mods
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
  /** OpenRouter: per-1M-token pricing for display. */
  pricing?: { promptPer1M: number; completionPer1M: number }
  /** OpenRouter: prefer these providers, allow fallbacks. */
  routing?: { providers?: string[]; allowFallbacks?: boolean }
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
  /** OpenRouter: provider routing preferences for the active model (resolved). */
  routing?: { providers?: string[]; allowFallbacks?: boolean }

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
    // Fall back to what the model id implies, not to text-only: a
    // hand-added vision model used to have its images silently diverted.
    modalities: m.modalities ?? inferModalities(p.kind, m.name),
    supportsEffort: m.supportsEffort ?? inferEffortSupport(p.kind, m.name),
    routing: m.routing,
  }
}

/** Preset providers with defaults (apiKey left empty for user to fill). */
export const PRESET_PROVIDERS: LLMProviderInput[] = [
  {
    // Ollama, LM Studio and llama.cpp's own server all expose the
    // OpenAI-compatible API this app already speaks, so a local model needs no
    // new transport and no key — the Authorization header is only sent when an
    // API key is set. Default port is Ollama's; LM Studio uses 1234 and
    // llama-server 8080.
    name: 'Local (Ollama / LM Studio / llama.cpp)',
    kind: 'openai',
    baseURL: 'http://localhost:11434/v1',
    apiKey: '',
    model: 'qwen2.5:7b',
    isActive: false,
    maxTokens: 4096,
    contextLimit: 32_768,
    models: [],
  },
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
