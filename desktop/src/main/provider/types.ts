/**
 * LLM Provider type definitions.
 */

export type ProviderKind = 'anthropic' | 'deepseek' | 'openai'

export interface LLMProvider {
  id: string
  name: string
  kind: ProviderKind
  baseURL: string
  apiKey: string // encrypted at rest
  model: string
  isActive: boolean
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
  },
  {
    name: 'DeepSeek',
    kind: 'deepseek',
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKey: '',
    model: 'deepseek-v4-pro',
    isActive: false,
  },
  {
    name: 'llama.cpp',
    kind: 'openai',
    baseURL: 'http://localhost:8080/v1',
    apiKey: '',
    model: 'local-model',
    isActive: false,
  },
]
