/**
 * Provider IPC handlers — CRUD for LLM providers from renderer.
 */

import { ipcMain } from 'electron'
import { getProviderManager } from '../provider/manager.js'
import type { LLMProviderInput } from '../provider/types.js'
import { fetchORModels, fetchORBalance } from '../llm/openrouter-api.js'
import { fetchProviderModels } from '../llm/fetch-models.js'
import {
  catalogAge,
  getCatalog,
  listCatalogProviders,
  providerModels,
} from '../llm/models-dev.js'
import {
  getModelRouting,
  setModelRouting,
  type ModelRouting,
} from '../provider/routing.js'

export function registerProvidersIPC(): void {
  const pm = getProviderManager()

  ipcMain.handle('providers:list', () => pm.list())
  ipcMain.handle('providers:get', (_e, id: string) => pm.get(id))
  ipcMain.handle('providers:getActive', () => pm.getActive())
  ipcMain.handle('providers:add', (_e, input: LLMProviderInput) => pm.add(input))
  ipcMain.handle('providers:update', (_e, id: string, input: Partial<LLMProviderInput>) =>
    pm.update(id, input),
  )
  ipcMain.handle('providers:remove', (_e, id: string) => pm.remove(id))
  ipcMain.handle('providers:setActive', (_e, id: string) => pm.setActive(id))
  ipcMain.handle(
    'providers:setActiveModel',
    (_e, providerId: string, modelId: string) =>
      pm.setActiveModel(providerId, modelId),
  )

  // ── OpenRouter metadata ────────────────────────────────────────────────
  ipcMain.handle(
    'providers:orModels',
    async (_e, apiKey: string) => {
      try {
        const models = await fetchORModels(apiKey)
        return { ok: true, models }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
  ipcMain.handle(
    'providers:orKeyInfo',
    async (_e, apiKey: string) => {
      try {
        const info = await fetchORBalance(apiKey)
        return { ok: true, info }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // ── models.dev catalog ─────────────────────────────────────────────────
  // Public metadata for ~5800 models, so adding one does not mean typing its
  // context window and modalities from memory. Fetched on demand and cached
  // for a day; a stale cache is served when the network is down.
  ipcMain.handle('providers:catalogProviders', async (_e, force?: boolean) => {
    try {
      const catalog = await getCatalog(force === true)
      return {
        ok: true,
        providers: listCatalogProviders(catalog),
        ageMs: catalogAge(),
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(
    'providers:catalogModels',
    async (_e, catalogProviderId: string) => {
      try {
        const catalog = await getCatalog()
        return { ok: true, models: providerModels(catalog, catalogProviderId) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // Discover models from a provider's own /v1/models — the only way to know
  // what a LOCAL server has loaded. Returns the list; the renderer decides
  // what to keep, so a discovery call can never silently rewrite a config.
  ipcMain.handle(
    "providers:fetchModels",
    async (
      _e,
      baseURL: string,
      apiKey: string,
    ): Promise<{ ok: boolean; models?: { name: string }[]; error?: string }> => {
      try {
        return { ok: true, models: await fetchProviderModels(baseURL, apiKey) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  // Model routing — which provider/model does the cheap background work
  // (memory log pass, nightly consolidation, Reflect). Empty = the active one.
  ipcMain.handle("routing:get", () => getModelRouting());
  ipcMain.handle("routing:set", (_e, patch: Partial<ModelRouting>) =>
    setModelRouting(patch),
  );
}
