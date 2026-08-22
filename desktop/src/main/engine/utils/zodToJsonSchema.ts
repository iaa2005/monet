/**
 * Converts Zod v4 schemas to JSON Schema using native toJSONSchema.
 */

import { toJSONSchema, type ZodTypeAny } from 'zod/v4'

export type JsonSchema7Type = Record<string, unknown>

// toolToAPISchema() runs this for every tool on every API request (~60-250
// times/turn). Tool schemas are wrapped with lazySchema() which guarantees the
// same ZodTypeAny reference per session, so we can cache by identity.
const cache = new WeakMap<ZodTypeAny, JsonSchema7Type>()

/**
 * Rewrite tuples into plain arrays, everywhere in the schema.
 *
 * Zod emits a tuple as `{type: "array", prefixItems: [...]}` — draft 2020-12,
 * and correct. Google's function-calling schema is not JSON Schema: it knows
 * `items` and nothing about `prefixItems`, so what it sees is an array with no
 * item type, and it refuses the WHOLE request:
 *
 *   GenerateContentRequest.tools[0].function_declarations[25].parameters
 *   .properties[region].any_of[1].items: missing field
 *
 * — reported from a live session on Gemini through OpenRouter. One tuple in
 * one optional field of one tool, and every Gemini model is unusable, with an
 * error that names an index rather than a tool.
 *
 * So it is fixed here, at the single door every tool schema goes through,
 * rather than in each schema that might grow a tuple later: positions become
 * one `items` (their common type, or an anyOf when they differ) and the length
 * survives as minItems/maxItems. Anthropic and OpenAI read that identically;
 * Google reads it at all.
 */
function untuple(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(untuple)
  if (!node || typeof node !== 'object') return node

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>))
    out[key] = untuple(value)

  const prefix = out['prefixItems']
  if (Array.isArray(prefix)) {
    delete out['prefixItems']
    if (out['items'] === undefined) {
      const shapes = prefix.map(p => JSON.stringify(p))
      const distinct = [...new Set(shapes)].map(s => JSON.parse(s) as unknown)
      out['items'] = distinct.length === 1 ? distinct[0] : { anyOf: distinct }
    }
    if (out['minItems'] === undefined) out['minItems'] = prefix.length
    if (out['maxItems'] === undefined) out['maxItems'] = prefix.length
  }
  return out
}

/**
 * Converts a Zod v4 schema to JSON Schema format.
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7Type {
  const hit = cache.get(schema)
  if (hit) return hit
  const result = untuple(toJSONSchema(schema)) as JsonSchema7Type
  cache.set(schema, result)
  return result
}
