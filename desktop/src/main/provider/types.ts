/**
 * LLM Provider type definitions.
 */

export type ProviderKind = 'anthropic' | 'deepseek' | 'openai' | 'openrouter'

export interface LLMProvider {
  id: string
  name: string
  kind: ProviderKind
  baseURL: string
  apiKey: string // encrypted at rest
  model: string
  isActive: boolean
  maxTokens: number
  temperature?: number
  /** Context window size in tokens. Defaults per preset (~200K Anthropic, 1M DeepSeek, 128K OpenAI). */
  contextLimit: number
  createdAt: string
  updatedAt: string
}

export type LLMProviderInput = Omit<LLMProvider, 'id' | 'createdAt' | 'updatedAt'>

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
  },
  {
    name: 'OpenRouter',
    kind: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: '',
    // The auto-router picks a model per request; set a concrete model id
    // (e.g. anthropic/claude-sonnet-4) in Settings for agentic tool use.
    model: 'openrouter/auto',
    isActive: false,
    maxTokens: 16000,
    contextLimit: 200_000,
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
  },
]
