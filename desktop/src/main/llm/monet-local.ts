/**
 * Monet Local's own model list.
 *
 * A plain OpenAI-compatible server answers `GET /v1/models` with ids and
 * nothing else, so every model added that way arrives as `{ id, name }` and
 * the per-model fields — context length, whether it can see images, whether
 * it has a reasoning knob — are left for the user to fill in by hand or to be
 * guessed from the id. Both are how a screenshot ends up silently diverted
 * from a model that could have read it.
 *
 * Monet Local knows all of it, because it read the GGUF header. This module
 * asks it, over its own endpoint, and returns models that need no guessing.
 *
 * It also returns ONLY what is loaded. That is the difference this kind of
 * provider exists for: loading is a decision made in Monet Local, in front of
 * a memory estimate, and a model that has been unloaded there must stop being
 * offered here rather than failing on the next request.
 */

import type { Modality } from '../provider/types.js'

/** `GET /monet-local/v1/info` — also the discovery probe. */
export interface MonetLocalInfo {
  name: string
  version?: string
  llama_build?: string
  backend?: string
  capabilities?: { openai?: boolean; anthropic?: boolean }
}

interface MonetLocalModel {
  id: string
  status?: 'unloaded' | 'loading' | 'loaded'
  display_name?: string
  architecture?: string
  quantisation?: string
  size_bytes?: number
  context_max?: number | null
  context_configured?: number | null
  /** `--n-predict`: the most tokens one answer may use. Null = unbounded. */
  predict_configured?: number | null
  /** `--reasoning-effort`: the steps this server takes, weakest first. */
  effort_levels?: string[]
  /** Tokens per second this machine can generate with it — see below. */
  generation_tps?: number | null
  modalities?: string[]
  verdict?: 'fits' | 'tight' | 'wont_fit'
}

export interface MonetLocalDiscovered {
  name: string
  label?: string
  contextLength?: number
  /**
   * The server's own ceiling on one answer.
   *
   * Worth carrying because the caller sets `max_tokens` on every request and
   * defaults to 16000 when nothing says otherwise: a profile raised to 32000
   * over there did nothing at all, because the limit that actually applied
   * was this side's default and this side had never been told.
   */
  maxOutputTokens?: number
  /**
   * The reasoning-effort steps this server takes, weakest first.
   *
   * llama.cpp's four (low…xhigh) are not OpenAI's four and not Anthropic's
   * none-at-all, and a composer offering one fixed ladder to all of them
   * shows steps that quietly do nothing. So it is asked for rather than
   * assumed — see @shared/effort.ts.
   */
  effortLevels?: string[]
  /**
   * Tokens per second the server expects to WRITE at.
   *
   * Only a local server can know this: generation is that machine's memory
   * bandwidth divided by the weights one token reads, and the second half
   * needs the model's tensor table. Measured on the machine this was written
   * for, two models in one library differed by seven times — 26 tok/s from a
   * mixture of experts against 4 from a larger dense model — and the picker
   * showed only their names.
   */
  generationTps?: number
  modalities?: Modality[]
  supportsEffort?: boolean
  /** Loaded right now. Unloaded models are not returned at all. */
  loaded: true
}

/** Strip `/v1` so both the standard and the management path can be built. */
function root(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/v1$/, '')
}

function headers(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' }
  // Local servers take no key, and an empty bearer makes some of them 401.
  if (apiKey) h.Authorization = `Bearer ${apiKey}`
  return h
}

/**
 * Is there a Monet Local at this address?
 *
 * Used by the "find it on this computer" button and to decide whether a
 * provider can use the rich list or has to fall back to plain `/v1/models` —
 * which is what happens against an older Monet Local, or against something
 * else entirely that someone pointed this kind at.
 */
export async function probeMonetLocal(
  baseURL: string,
  apiKey = '',
  signal?: AbortSignal,
): Promise<MonetLocalInfo | null> {
  try {
    const res = await fetch(`${root(baseURL)}/monet-local/v1/info`, {
      headers: headers(apiKey),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) return null
    const info = (await res.json()) as MonetLocalInfo
    return info?.name ? info : null
  } catch {
    return null
  }
}

export async function fetchMonetLocalModels(
  baseURL: string,
  apiKey = '',
): Promise<MonetLocalDiscovered[]> {
  const res = await fetch(`${root(baseURL)}/monet-local/v1/models`, {
    headers: headers(apiKey),
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200)
    throw new Error(`${res.status} from Monet Local${body ? `: ${body}` : ''}`)
  }
  const json = (await res.json()) as { data?: MonetLocalModel[] }

  return (json.data ?? [])
    .filter((m) => m.status === 'loaded' && typeof m.id === 'string')
    .map((m) => {
      const modalities = (m.modalities ?? ['text']).filter(
        (x): x is Modality =>
          x === 'text' || x === 'image' || x === 'audio' || x === 'video' || x === 'file',
      )
      // The context the model is CONFIGURED with, not the one it advertises:
      // a 262144-token model running at 8192 will refuse anything longer, and
      // a compaction budget built on the advertised figure would walk into it.
      const ctx = m.context_configured ?? m.context_max ?? undefined
      // Null means unbounded (-1) or unset, and neither is a number to send
      // as max_tokens — left off, so this side's own default applies.
      const predict =
        typeof m.predict_configured === 'number' && m.predict_configured > 0
          ? m.predict_configured
          : undefined
      const efforts = (m.effort_levels ?? []).filter(
        (x): x is string => typeof x === 'string' && x.trim().length > 0,
      )
      return {
        name: m.id,
        ...(m.display_name ? { label: m.display_name } : {}),
        ...(ctx ? { contextLength: ctx } : {}),
        ...(predict ? { maxOutputTokens: predict } : {}),
        ...(efforts.length ? { effortLevels: efforts } : {}),
        ...(typeof m.generation_tps === 'number' && m.generation_tps > 0
          ? { generationTps: m.generation_tps }
          : {}),
        modalities: modalities.length ? modalities : (['text'] as Modality[]),
        loaded: true as const,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
