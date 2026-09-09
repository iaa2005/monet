/**
 * The Monet Local provider, against a server that answers like one.
 *
 * What this is defending: a model added from a plain `/v1/models` arrives as a
 * bare id, so its context window and its modalities are GUESSED. The comments
 * in provider/types.ts describe where that ends — the app decides a model
 * cannot see, and quietly diverts a screenshot to stashUnsupported. Monet
 * Local knows the real answers because it read the GGUF header, and this
 * probe is what stops that path from silently reverting to guesswork.
 *
 * Three things are checked against a stub that speaks Monet Local's shape:
 * only LOADED models are offered, the CONFIGURED context wins over the
 * advertised one, and a server without the management endpoint still works as
 * an ordinary OpenAI one.
 *
 *   npm run smoke:monetlocal
 */

import { createServer, type Server } from 'node:http'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(
      `FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    )
  }
}

const { fetchProviderModels } = await import('../src/main/llm/fetch-models.js')
const { fetchMonetLocalModels, probeMonetLocal } = await import(
  '../src/main/llm/monet-local.js'
)
const { PRESET_PROVIDERS, hasDynamicModels } = await import(
  '../src/main/provider/types.js'
)
const { createAdapter } = await import('../src/main/llm/adapter.js')
const { merge, same } = await import('../src/main/llm/monet-local-sync.js')

/** One loaded model with everything filled in, one that is not loaded. */
const MODELS = [
  {
    id: 'qwen3.8-27b-q4_k_m',
    object: 'model',
    status: 'loaded',
    display_name: 'Qwen_Qwen3.8 27B',
    architecture: 'qwen35',
    quantisation: 'Q4_K_M',
    size_bytes: 16_810_714_336,
    // Advertised 262144, actually running at 8192 — the gap that matters.
    context_max: 262_144,
    context_configured: 8192,
    // The profile's --n-predict. The caller's own default is 16000, so
    // without this a model configured to answer at length is asked for less
    // than half of what it was given.
    predict_configured: 32_000,
    modalities: ['text', 'image'],
    moe: false,
    verdict: 'fits',
  },
  {
    id: 'qwen3.8-27b-q6_k',
    object: 'model',
    status: 'unloaded',
    display_name: 'Qwen_Qwen3.8 27B',
    architecture: 'qwen35',
    quantisation: 'Q6_K',
    size_bytes: 22_430_999_776,
    context_max: 262_144,
    context_configured: 8192,
    modalities: ['text'],
    moe: false,
    verdict: 'wont_fit',
  },
]

/** Ids the stub pretends have been unloaded since the last read. */
const dropped = new Set<string>()

function serve(withManagement: boolean): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const json = (body: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/monet-local/v1/info') {
      if (!withManagement) return json({ error: 'not found' }, 404)
      return json({ name: 'Monet Local', version: '0.1.0', backend: 'vulkan' })
    }
    if (req.url === '/monet-local/v1/models') {
      if (!withManagement) return json({ error: 'not found' }, 404)
      return json({ data: MODELS.filter((m) => !dropped.has(m.id)) })
    }
    if (req.url?.startsWith('/v1/models')) {
      // The standard endpoint shows only what is loaded, as the gateway does.
      return json({ data: [{ id: 'qwen3.8-27b-q4_k_m', object: 'model' }] })
    }
    json({ error: 'unknown' }, 404)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () =>
          new Promise<void>((r) => {
            // Keep-alive sockets outlive close() and, on Windows, a handle
            // still shutting down when the process exits aborts it — the
            // probe passed every check and then died with a libuv assertion
            // and exit 127, which in CI is simply a red build.
            server.closeAllConnections()
            server.close(() => r())
          }),
      })
    })
  })
}

// ─── A server that speaks Monet Local ───────────────────────────────────

{
  const s = await serve(true)

  const info = await probeMonetLocal(s.url)
  check('a Monet Local is recognised at its address', info?.name === 'Monet Local', info)

  const rich = await fetchMonetLocalModels(s.url)
  check('only loaded models are offered', rich.length === 1, rich.map((m) => m.name))
  check(
    'an unloaded model is not offered',
    !rich.some((m) => m.name === 'qwen3.8-27b-q6_k'),
  )

  const [model] = rich
  check('the display name comes across', model?.label === 'Qwen_Qwen3.8 27B', model?.label)
  // The whole reason this kind exists rather than "OpenAI Compatible": a
  // model advertising 262144 but running at 8192 refuses anything longer, and
  // a compaction budget built on the advertised figure walks straight into it.
  check(
    'the CONFIGURED context wins over the advertised one',
    model?.contextLength === 8192,
    model?.contextLength,
  )
  check(
    'the ANSWER limit comes across too, not just the context',
    model?.maxOutputTokens === 32_000,
    model?.maxOutputTokens,
  )
  check(
    'vision is reported, not guessed from the id',
    !!model?.modalities?.includes('image'),
    model?.modalities,
  )

  // The path the provider form actually calls.
  const viaKind = await fetchProviderModels(s.url, '', 'monet-local')
  check(
    'the provider form gets the same rich list',
    viaKind.length === 1 && viaKind[0]?.contextLength === 8192,
    viaKind,
  )

  await s.close()
}

// ─── A server without the management endpoint ───────────────────────────

{
  const s = await serve(false)

  check('an ordinary server is not mistaken for one', (await probeMonetLocal(s.url)) === null)

  // An older Monet Local, or something else pointed at this kind, must still
  // work — as a plain OpenAI provider, with the fields left for the user.
  const fallback = await fetchProviderModels(s.url, '', 'monet-local')
  check('discovery falls back to /v1/models', fallback.length === 1, fallback)
  check(
    'and claims nothing it does not know',
    fallback[0]?.contextLength === undefined && fallback[0]?.modalities === undefined,
    fallback[0],
  )

  await s.close()
}

// ─── Wiring ─────────────────────────────────────────────────────────────

{
  check('the kind is marked as having a live model list', hasDynamicModels('monet-local'))
  check('other kinds are not', !hasDynamicModels('openai'))

  const preset = PRESET_PROVIDERS.find((p) => p.kind === 'monet-local')
  check('a preset exists so nothing has to be typed', !!preset, preset?.name)
  check(
    'and points at this computer on Monet Local\'s port',
    preset?.baseURL === 'http://127.0.0.1:17171/v1',
    preset?.baseURL,
  )
  check('with no model spelled out to go stale', preset?.models.length === 0)

  // The transport is the existing one; a missing case here would throw
  // "Unknown provider kind" on the first message rather than at startup.
  const adapter = createAdapter({
    id: 'p',
    name: 'Monet Local',
    kind: 'monet-local',
    baseURL: 'http://127.0.0.1:17171/v1',
    apiKey: '',
    model: 'qwen3.8-27b-q4_k_m',
  } as Parameters<typeof createAdapter>[0])
  check('a request has a transport', typeof adapter.stream === 'function')
}

// ─── The list is a reading, not a setting ───────────────────────────────
//
// What "dynamic" was supposed to mean and did not: nothing refreshed the
// stored list, so unloading a model in Monet Local left it on offer here
// until someone reopened the settings dialog and pressed a button.

{
  const s = await serve(true)

  const first = merge([], await fetchProviderModels(s.url, '', 'monet-local'))
  check('a first read produces the loaded model', first.length === 1, first)

  check(
    'and it carries the server answer limit into the stored record',
    first[0]?.maxOutputTokens === 32_000,
    first[0]?.maxOutputTokens,
  )

  // The user hides it and the composer pins it; neither may be churned by a
  // refresh that found nothing new.
  const kept = first.map((m) => ({ ...m, hidden: true }))
  const again = merge(kept, await fetchProviderModels(s.url, '', 'monet-local'))
  check('the generated id survives a refresh', again[0]?.id === kept[0]?.id)
  check('the hidden flag survives a refresh', again[0]?.hidden === true)
  check('an unchanged list is recognised as unchanged', same(kept, again))

  // THE ONE THAT BIT: this runs every ten seconds and replaces the list, so
  // a per-model setting not carried across is erased moments after it is
  // typed — and the settings screen shows the erased value, so it looks like
  // the app simply ignored what was entered.
  {
    const typed = again.map((m) => ({
      ...m,
      temperature: 0.3,
      maxInputTokens: 6000,
      streamTimeoutSec: 1800,
    }))
    const round = merge(typed, await fetchProviderModels(s.url, '', 'monet-local'))
    check('a hand-set temperature survives the ten-second refresh', round[0]?.temperature === 0.3, round[0])
    check('so does a per-model silence timeout', round[0]?.streamTimeoutSec === 1800)
    check('and a per-model input limit', round[0]?.maxInputTokens === 6000)
    check(
      'and none of that counts as a change worth rewriting the store for',
      same(typed, round),
    )
  }

  // Now it is unloaded over there.
  dropped.add('qwen3.8-27b-q4_k_m')
  const after = merge(again, await fetchProviderModels(s.url, '', 'monet-local'))
  check('an unloaded model stops being offered', after.length === 0, after)
  check('and that counts as a change worth storing', !same(again, after))

  dropped.clear()
  await s.close()
}

console.log(failures ? `\n${failures} FAILED` : '\nMONET LOCAL PROVIDER OK')
// Set rather than exit(): with sockets still unwinding, a hard exit is what
// tripped a libuv assertion on Windows — every check passing and the process
// still dying, which in CI is simply a red build. Nothing here holds the loop
// open, so Node leaves on its own.
process.exitCode = failures ? 1 : 0
