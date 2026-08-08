/**
 * Provider Manager — CRUD + encryption for LLM providers.
 *
 * Stores providers as JSON in user data directory.
 * API keys are encrypted via Electron safeStorage (DPAPI/Keychain/libsecret).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { LLMProvider, LLMProviderInput } from './types.js'
import { PRESET_PROVIDERS } from './types.js'
import { getDataSubdir } from '../data-dir.js'
import { resolveProvider, inferEffortSupport } from './types.js'

function getStoragePath(): string {
  return join(getDataSubdir('providers'), 'providers.json')
}

function encrypt(text: string): string {
  if (!text) return ''
  if (!safeStorage.isEncryptionAvailable()) return text // fallback: plain
  return safeStorage.encryptString(text).toString('base64')
}

function decrypt(encrypted: string): string {
  if (!encrypted) return ''
  if (!safeStorage.isEncryptionAvailable()) return encrypted
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return encrypted // fallback: already plain
  }
}

function loadProviders(): LLMProvider[] {
  const path = getStoragePath()
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return raw.map((p: LLMProvider) => migrateModels({
      ...p,
      apiKey: decrypt(p.apiKey),
    }))
  } catch {
    return []
  }
}

/** Pre-models[] configs stored one flat model per provider — lift those
 * fields into a single models[] entry so the UI always has a list. */
function migrateModels(p: LLMProvider): LLMProvider {
  if (p.models && p.models.length > 0) {
    if (!p.activeModelId || !p.models.some(m => m.id === p.activeModelId)) {
      p.activeModelId = p.models[0].id
    }
    return p
  }
  const id = randomUUID()
  return {
    ...p,
    models: [
      {
        id,
        name: p.model || 'model',
        contextLength: p.contextLimit,
        maxOutputTokens: p.maxTokens,
        temperature: p.temperature,
      },
    ],
    activeModelId: id,
  }
}

function saveProviders(providers: LLMProvider[]): void {
  const path = getStoragePath()
  const safe = providers.map(p => ({
    ...p,
    apiKey: encrypt(p.apiKey),
  }))
  writeFileSync(path, JSON.stringify(safe, null, 2), 'utf-8')
}

// ─── Public API ─────────────────────────────────────────────────────────

export class ProviderManager {
  private providers: LLMProvider[] = []

  constructor() {
    this.providers = loadProviders()

    // Seed presets on first run
    if (this.providers.length === 0) {
      const now = new Date().toISOString()
      this.providers = PRESET_PROVIDERS.map(p => ({
        ...p,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
      }))
      saveProviders(this.providers)
    } else if (!this.providers.some(p => p.kind === 'openrouter')) {
      // Migration: OpenRouter preset postdates existing installs — append it
      // once so the entry shows up ready for an API key.
      const preset = PRESET_PROVIDERS.find(p => p.kind === 'openrouter')
      if (preset) {
        const now = new Date().toISOString()
        this.providers.push({
          ...preset,
          isActive: false,
          id: randomUUID(),
          createdAt: now,
          updatedAt: now,
        })
        saveProviders(this.providers)
      }
    }
  }

  list(): LLMProvider[] {
    // Resolve each model's effort support (explicit flag or inferred) so the
    // composer can gate the Effort control without duplicating the heuristic.
    return this.providers.map(p => ({
      ...p,
      models: p.models?.map(m => ({
        ...m,
        supportsEffort: m.supportsEffort ?? inferEffortSupport(p.kind, m.name),
      })),
    }))
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.find(p => p.id === id)
  }

  /** The active provider with its active model FLATTENED into the legacy
   * single-model fields (model/maxTokens/temperature/contextLimit/baseURL).
   * Everything that talks to the LLM consumes this resolved view. */
  getActive(): LLMProvider | undefined {
    const p = this.providers.find(p => p.isActive)
    return p ? resolveProvider(p) : undefined
  }

  add(input: LLMProviderInput): LLMProvider {
    const now = new Date().toISOString()
    const provider: LLMProvider = migrateModels({
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    })
    this.providers.push(provider)
    saveProviders(this.providers)
    return provider
  }

  update(id: string, input: Partial<LLMProviderInput>): LLMProvider | null {
    const idx = this.providers.findIndex(p => p.id === id)
    if (idx === -1) return null

    this.providers[idx] = migrateModels({
      ...this.providers[idx],
      ...input,
      updatedAt: new Date().toISOString(),
    })
    saveProviders(this.providers)
    return this.providers[idx]
  }

  /** Switch the in-use model — also makes its provider the active one. */
  setActiveModel(providerId: string, modelId: string): boolean {
    const provider = this.providers.find(p => p.id === providerId)
    if (!provider || !provider.models?.some(m => m.id === modelId)) return false
    provider.activeModelId = modelId
    provider.updatedAt = new Date().toISOString()
    this.providers.forEach(p => { p.isActive = p.id === providerId })
    saveProviders(this.providers)
    return true
  }

  remove(id: string): boolean {
    const idx = this.providers.findIndex(p => p.id === id)
    if (idx === -1) return false

    this.providers.splice(idx, 1)
    saveProviders(this.providers)
    return true
  }

  setActive(id: string): boolean {
    const provider = this.providers.find(p => p.id === id)
    if (!provider) return false

    this.providers.forEach(p => { p.isActive = p.id === id })
    saveProviders(this.providers)
    return true
  }
}

// Singleton
let instance: ProviderManager | null = null

export function getProviderManager(): ProviderManager {
  if (!instance) instance = new ProviderManager()
  return instance
}

/** Forget the loaded providers, so the next call reads the folder that is
 * current now. Called when the data directory is switched. */
export function resetProviderManager(): void {
  instance = null
}
