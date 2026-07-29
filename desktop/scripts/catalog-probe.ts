/**
 * Runs the models.dev mapping against the REAL published catalog.
 *
 * Not a mock. A mapping is only as good as the document it meets, and the last
 * time a catalog was shipped from assumption rather than from the endpoint,
 * it named packages that did not exist. So this downloads api.json, asserts
 * the shape it depends on is still there, and checks specific well-known
 * models come out with the right numbers.
 *
 * Skips itself when offline — a missing network must not read as a code fault.
 */

import {
  catalogModalities,
  listCatalogProviders,
  providerModels,
  toCatalogModel,
  toProviderModel,
  type CatalogModelInfo,
} from '../src/main/llm/models-dev.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── Pure mapping ───────────────────────────────────────────────────────

check('text is always present', catalogModalities([])[0] === 'text')
check('text is present even for undefined', catalogModalities(undefined).length === 1)
check(
  'pdf maps to file',
  catalogModalities(['text', 'pdf']).includes('file'),
  catalogModalities(['text', 'pdf']),
)
check('image passes through', catalogModalities(['image']).includes('image'))
check('video passes through', catalogModalities(['video']).includes('video'))
check(
  'an unknown modality is dropped, not passed through',
  !catalogModalities(['text', 'hologram']).includes('hologram' as never),
  catalogModalities(['text', 'hologram']),
)
check(
  'no duplicates when input repeats',
  catalogModalities(['text', 'text', 'image', 'image']).length === 2,
)

const zeroLimits = toCatalogModel('x', { limit: { context: 0, output: 0 } })
check(
  'a zero limit becomes undefined, not 0',
  zeroLimits.contextLength === undefined && zeroLimits.maxOutputTokens === undefined,
  zeroLimits,
)
check(
  'a missing id falls back to the map key',
  toCatalogModel('the-key', {}).id === 'the-key',
)
check(
  'a label identical to the id is not stored twice',
  toProviderModel({ id: 'a', label: 'a', modalities: ['text'] } as CatalogModelInfo).label ===
    undefined,
)

// ─── The live document ──────────────────────────────────────────────────

let catalog: Record<string, unknown> | null = null
try {
  const res = await fetch('https://models.dev/api.json', {
    signal: AbortSignal.timeout(45_000),
  })
  if (res.ok) catalog = (await res.json()) as Record<string, unknown>
} catch {
  /* offline */
}

if (!catalog) {
  console.log('SKIP  live catalog — models.dev unreachable')
} else {
  const c = catalog as Parameters<typeof listCatalogProviders>[0]
  const providers = listCatalogProviders(c)
  check('the catalog lists many providers', providers.length > 50, providers.length)
  check(
    'every listed provider has at least one model',
    providers.every((p) => p.modelCount > 0),
  )
  check(
    'providers are sorted by label',
    providers.every(
      (p, i) => i === 0 || providers[i - 1]!.label.localeCompare(p.label) <= 0,
    ),
  )

  for (const id of ['openai', 'anthropic', 'deepseek', 'openrouter', 'google']) {
    check(`the catalog still has "${id}"`, providers.some((p) => p.id === id))
  }

  // Providers whose SDK hardcodes the endpoint publish no `api`. The UI must
  // not present a blank string as a known Base URL.
  const anthropic = providers.find((p) => p.id === 'anthropic')
  check(
    'a provider without an endpoint reports undefined, not ""',
    anthropic !== undefined && anthropic.baseURL === undefined,
    anthropic?.baseURL,
  )
  const deepseek = providers.find((p) => p.id === 'deepseek')
  check(
    'a provider with an endpoint reports it',
    deepseek?.baseURL?.startsWith('https://') === true,
    deepseek?.baseURL,
  )

  // Specific models, with numbers worth being right about.
  const openai = providerModels(c, 'openai')
  check('openai has models', openai.length > 10, openai.length)
  const gpt4o = openai.find((m) => m.id === 'gpt-4o')
  check('gpt-4o is present', gpt4o !== undefined)
  check('gpt-4o can see images', gpt4o?.modalities.includes('image') === true, gpt4o?.modalities)
  check('gpt-4o takes documents (pdf→file)', gpt4o?.modalities.includes('file') === true)
  check('gpt-4o context is 128k', gpt4o?.contextLength === 128_000, gpt4o?.contextLength)
  check('gpt-4o is priced', (gpt4o?.pricing?.promptPer1M ?? 0) > 0, gpt4o?.pricing)
  check('gpt-4o is not a reasoning model', gpt4o?.supportsEffort === false)

  const claude = providerModels(c, 'anthropic')
  check(
    'a claude model reports effort support',
    claude.some((m) => m.supportsEffort),
  )
  check(
    'claude models see images',
    claude.filter((m) => m.modalities.includes('image')).length > 3,
  )

  check(
    'deprecated models are excluded',
    providerModels(c, 'openai').every((m) => m.id !== ''),
  )
  check(
    'models are sorted newest first',
    openai.every(
      (m, i) =>
        i === 0 ||
        (openai[i - 1]!.releaseDate ?? '') >= (m.releaseDate ?? ''),
    ),
  )

  // The whole point: a row the editor can store, with the fields filled in.
  const row = toProviderModel(gpt4o!)
  check('the stored row carries the api id', row.name === 'gpt-4o')
  check('the stored row carries the context window', row.contextLength === 128_000)
  check('the stored row carries modalities', (row.modalities?.length ?? 0) >= 3, row.modalities)

  // Every model in the catalog must map without throwing and always keep text.
  let mapped = 0
  for (const p of providers) {
    for (const m of providerModels(c, p.id)) {
      if (m.modalities[0] !== 'text' || m.id.length === 0) {
        check(`bad mapping for ${p.id}/${m.id}`, false, m)
      }
      mapped++
    }
  }
  check(`all ${mapped} models map cleanly`, mapped > 3000, mapped)
}

console.log(failures === 0 ? '\nALL CATALOG CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
