/**
 * Checks the modality inference and, more importantly, that resolveProvider
 * uses it.
 *
 * The bug being pinned down: only the OpenRouter browser ever filled
 * `modalities` in. Every hand-added model was `{ id, name }`, resolveProvider
 * defaulted it to `['text']`, and chat.ts then diverted attached images to
 * stashUnsupported() — no error, just a model answering about a picture it was
 * never shown.
 *
 * Regexes are easy to get wrong at the edges, so the table below deliberately
 * includes the models that must NOT gain a modality (gpt-3.5, claude-2,
 * deepseek-chat) next to the ones that must.
 */

import {
  inferModalities,
  resolveProvider,
  type LLMProvider,
  type Modality,
  type ProviderKind,
} from '../src/main/provider/types.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

function has(kind: ProviderKind, model: string, mod: Modality): boolean {
  return inferModalities(kind, model).includes(mod)
}

// ─── Must see images ────────────────────────────────────────────────────

const SEES: [ProviderKind, string][] = [
  ['openai', 'gpt-4o'],
  ['openai', 'gpt-4o-mini'],
  ['openai', 'gpt-4.1'],
  ['openai', 'gpt-4-turbo'],
  ['openai', 'gpt-5'],
  ['openai', 'o3-mini'],
  ['anthropic', 'claude-sonnet-4-5'],
  ['anthropic', 'claude-3-opus-20240229'],
  ['anthropic', 'claude-opus-4-8'],
  ['openai', 'gemini-2.5-pro'],
  ['openai', 'qwen2.5-vl-72b'],
  ['openai', 'llava-1.6'],
  ['openai', 'pixtral-12b'],
  ['openai', 'llama-3.2-90b-vision'],
  ['openai', 'kimi-k3'],
  ['deepseek', 'deepseek-vl-7b'],
]
for (const [k, m] of SEES) check(`sees images: ${m}`, has(k, m, 'image'), inferModalities(k, m))

// ─── Must NOT see images ────────────────────────────────────────────────

const BLIND: [ProviderKind, string][] = [
  ['openai', 'gpt-3.5-turbo'],
  ['deepseek', 'deepseek-chat'],
  ['deepseek', 'deepseek-reasoner'],
  ['openai', 'text-embedding-3-large'],
  ['openai', 'qwen2.5-coder-32b'],
  ['openai', 'llama-3.1-70b'],
]
for (const [k, m] of BLIND)
  check(`stays text-only: ${m}`, !has(k, m, 'image'), inferModalities(k, m))

// ─── Wider modalities ───────────────────────────────────────────────────

check('gemini takes video', has('openai', 'gemini-2.5-flash', 'video'))
check('gemini takes audio', has('openai', 'gemini-2.5-flash', 'audio'))
check('kimi k3 takes video', has('openai', 'kimi-k3', 'video'))
check('claude 4 takes documents', has('anthropic', 'claude-sonnet-4-5', 'file'))
check(
  'claude 3 does NOT claim documents',
  !has('anthropic', 'claude-3-sonnet-20240229', 'file'),
  inferModalities('anthropic', 'claude-3-sonnet-20240229'),
)
check(
  'a non-vision model claims no video',
  !has('deepseek', 'deepseek-chat', 'video'),
)
check('text is always present', inferModalities('openai', 'whatever-9000')[0] === 'text')

// An anthropic-kind endpoint serving an unknown id is still probably a Claude.
check(
  'unknown model on an anthropic endpoint gets vision',
  has('anthropic', 'internal-preview-x', 'image'),
)
check(
  'unknown model on an openai endpoint does not',
  !has('openai', 'internal-preview-x', 'image'),
)

// ─── resolveProvider actually uses it ───────────────────────────────────

const base = {
  id: 'p1',
  name: 'Gateway',
  kind: 'openai' as ProviderKind,
  baseURL: 'https://my-gateway.internal/v1',
  apiKey: 'k',
  maxTokens: 8000,
  contextLimit: 128_000,
  createdAt: '',
  updatedAt: '',
}

// The exact shape the "Add model" button creates: id + name, nothing else.
const handAdded = resolveProvider({
  ...base,
  model: 'gpt-4o',
  activeModelId: 'm1',
  models: [{ id: 'm1', name: 'gpt-4o' }],
} as unknown as LLMProvider)
check(
  'a hand-added gpt-4o resolves WITH image support',
  handAdded.modalities?.includes('image') === true,
  handAdded.modalities,
)

const explicitText = resolveProvider({
  ...base,
  model: 'gpt-4o',
  activeModelId: 'm1',
  models: [{ id: 'm1', name: 'gpt-4o', modalities: ['text'] as Modality[] }],
} as unknown as LLMProvider)
check(
  'an explicit modality list still wins over the guess',
  explicitText.modalities?.length === 1 && explicitText.modalities[0] === 'text',
  explicitText.modalities,
)

const textModel = resolveProvider({
  ...base,
  kind: 'deepseek',
  model: 'deepseek-chat',
  activeModelId: 'm1',
  models: [{ id: 'm1', name: 'deepseek-chat' }],
} as unknown as LLMProvider)
check(
  'a text-only model is not given vision',
  textModel.modalities?.includes('image') === false,
  textModel.modalities,
)

console.log(failures === 0 ? '\nALL MODALITY CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
