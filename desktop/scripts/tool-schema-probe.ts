/**
 * Every tool schema must be one Google can read.
 *
 * Reported from a live session on Gemini through OpenRouter:
 *
 *   GenerateContentRequest.tools[0].function_declarations[25].parameters
 *   .properties[region].any_of[1].items: missing field
 *
 * One optional field of one tool was a zod tuple, which JSON Schema spells as
 * `prefixItems` and Google's function-calling schema does not know at all — it
 * sees an array with no item type and refuses the entire request. Every Gemini
 * model, dead, with an error naming an index instead of a tool.
 *
 * So the rule is checked over the whole advertised tool set, not the one field
 * that was found: no `prefixItems` anywhere, and every array says what it holds.
 *
 *   npm run smoke:toolschema
 */

import { getAllToolsForSeeding } from "../src/main/agent/vendor-tools.js";
import { zodToJsonSchema } from "../src/main/engine/utils/zodToJsonSchema.js";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log("      ", JSON.stringify(detail).slice(0, 300));
  }
}

/** Every place in a schema where Google would ask "items: missing field". */
function offences(node: unknown, path = ""): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => offences(n, `${path}[${i}]`));
  if (!node || typeof node !== "object") return [];
  const obj = node as Record<string, unknown>;
  const found: string[] = [];
  if ("prefixItems" in obj) found.push(`${path || "."} has prefixItems`);
  if (obj["type"] === "array" && obj["items"] === undefined)
    found.push(`${path || "."} is an array with no items`);
  for (const [k, v] of Object.entries(obj)) found.push(...offences(v, `${path}.${k}`));
  return found;
}

const tools = getAllToolsForSeeding();
check(`the tool set is here — ${tools.length} tools`, tools.length > 30, tools.length);

const bad: { tool: string; problems: string[] }[] = [];
for (const tool of tools) {
  const schema = (tool as { inputSchema?: unknown; inputJSONSchema?: unknown });
  const json = schema.inputJSONSchema
    ? (schema.inputJSONSchema as Record<string, unknown>)
    : zodToJsonSchema(schema.inputSchema as never);
  const problems = offences(json);
  if (problems.length) bad.push({ tool: (tool as { name: string }).name, problems });
}
check(
  "no tool ships an array Google cannot read",
  bad.length === 0,
  bad,
);

// The specific field from the report, by name — a rewrite that drops the
// bounded array and reaches for z.tuple() again fails here.
const computer = tools.find((t) => (t as { name: string }).name === "Computer");
if (computer) {
  const json = zodToJsonSchema(
    (computer as { inputSchema: never }).inputSchema,
  ) as { properties?: Record<string, { anyOf?: Record<string, unknown>[] }> };
  const region = json.properties?.["region"];
  const arrayVariant = region?.anyOf?.find((v) => v["type"] === "array");
  check("Computer.region still takes [x, y, w, h]", !!arrayVariant, region);
  check(
    "…and says the array holds numbers",
    !!arrayVariant && JSON.stringify(arrayVariant["items"]) === JSON.stringify({ type: "number" }),
    arrayVariant,
  );
  check(
    "…with the length kept as min/max, not as positions",
    arrayVariant?.["minItems"] === 4 && arrayVariant?.["maxItems"] === 4,
    arrayVariant,
  );
} else check("the computer tool is in the set", false);

// And the door itself: a tuple handed to the converter comes out readable.
{
  const { z } = await import("zod/v4");
  const converted = zodToJsonSchema(
    z.object({ pair: z.tuple([z.number(), z.string()]) }) as never,
  ) as { properties: Record<string, Record<string, unknown>> };
  const pair = converted.properties["pair"]!;
  check("the converter rewrites any tuple, not just this one", !("prefixItems" in pair));
  check(
    "…keeping both position types as an anyOf",
    JSON.stringify(pair["items"]) ===
      JSON.stringify({ anyOf: [{ type: "number" }, { type: "string" }] }),
    pair,
  );
}

console.log(
  failures === 0
    ? "\nEVERY TOOL SCHEMA SURVIVES GOOGLE"
    : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
