/**
 * Provider Store — Zustand store for LLM provider state in renderer.
 *
 * Initially seeded from presets. In Step 2.3, IPC handlers will sync
 * with the main process ProviderManager.
 */

import { create } from 'zustand'

export type ProviderKind = 'anthropic' | 'deepseek' | 'openai'

export interface LLMProvider {
  id: string
  name: string
  kind: ProviderKind
  baseURL: string
  apiKey: string
  model: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type LLMProviderInput = Omit<LLMProvider, 'id' | 'createdAt' | 'updatedAt'>

interface ProviderStore {
  providers: LLMProvider[]
  activeId: string | null

  add: (input: LLMProviderInput) => void
  update: (id: string, input: Partial<LLMProviderInput>) => void
  remove: (id: string) => void
  setActive: (id: string) => void
  getActive: () => LLMProvider | undefined
}

function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)
}

const PRESETS: LLMProviderInput[] = [
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

export const useProviderStore = create<ProviderStore>((set, get) => ({
  providers: PRESETS.map(p => ({
    ...p,
    id: generateId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  activeId: null,

  add: (input) => {
    const now = new Date().toISOString()
    const provider: LLMProvider = { ...input, id: generateId(), createdAt: now, updatedAt: now }
    set(s => ({ providers: [...s.providers, provider] }))
  },

  update: (id, input) => {
    set(s => ({
      providers: s.providers.map(p =>
        p.id === id ? { ...p, ...input, updatedAt: new Date().toISOString() } : p,
      ),
    }))
  },

  remove: (id) => {
    set(s => ({
      providers: s.providers.filter(p => p.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    }))
  },

  setActive: (id) => {
    set(s => ({
      activeId: id,
      providers: s.providers.map(p => ({ ...p, isActive: p.id === id })),
    }))
  },

  getActive: () => {
    const { providers, activeId } = get()
    return (
      providers.find(p => p.id === activeId) ||
      providers.find(p => p.isActive)
    )
  },
}))
