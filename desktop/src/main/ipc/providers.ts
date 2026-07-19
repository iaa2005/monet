/**
 * Provider IPC handlers — CRUD for LLM providers from renderer.
 */

import { ipcMain } from 'electron'
import { getProviderManager } from '../provider/manager.js'
import type { LLMProviderInput } from '../provider/types.js'
import { fetchORModels, fetchORBalance } from '../llm/openrouter-api.js'

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
}
