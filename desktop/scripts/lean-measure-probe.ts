/**
 * What Lean tool descriptions actually buy, and what they cost.
 *
 * The setting claims "TodoWrite 9114 → 3288 characters, ~1.6K tokens saved on
 * every request". Claims like that rot: tool prompts change upstream, and a
 * stripper tuned to one shape quietly stops matching. So this measures the
 * REAL prompts of the REAL toolset, both ways, and — more importantly —
 * checks that nothing load-bearing was removed: every NEVER / IMPORTANT /
 * ALWAYS / "do not" line must survive, or the saving is bought with rules.
 */

import { getVendorTools } from "../src/main/agent/vendor-tools";
import { stripExamples } from "../src/main/agent/lean-context";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Rough but stable: ~4 chars per token for English prose. */
const tok = (chars: number): number => Math.round(chars / 4);

/** Lines that constrain behaviour rather than illustrate it. */
const RULE = /\b(NEVER|ALWAYS|IMPORTANT|MUST|REQUIRED|do not|don't|only use|refuse)\b/i;

function ruleLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => RULE.test(l));
}

const tools = getVendorTools();
console.log(`Measuring ${tools.length} tools\n`);

let fullTotal = 0;
let leanTotal = 0;
const rows: { name: string; full: number; lean: number; lost: number }[] = [];

for (const tool of tools) {
  let full = "";
  try {
    full = await tool.prompt({} as never);
  } catch {
    continue; // a prompt that needs context it has none of here
  }
  const lean = stripExamples(full);
  fullTotal += full.length;
  leanTotal += lean.length;

  // Every rule line must still be there, allowing for the whitespace the
  // stripper collapses.
  const before = ruleLines(full);
  const after = new Set(ruleLines(lean));
  const lost = before.filter((l) => !after.has(l));
  rows.push({ name: tool.name, full: full.length, lean: lean.length, lost: lost.length });

  if (lost.length > 0) {
    check(`${tool.name}: keeps every rule line`, false, lost[0].slice(0, 80));
  }
}

rows.sort((a, b) => b.full - b.lean - (a.full - a.lean));
console.log("Biggest savings:");
for (const r of rows.slice(0, 8))
  console.log(
    `  ${r.name.padEnd(18)} ${String(r.full).padStart(6)} → ${String(r.lean).padStart(6)} chars  (−${tok(r.full - r.lean)} tok)`,
  );

const unchanged = rows.filter((r) => r.full === r.lean).length;
console.log(
  `\nTOTAL ${fullTotal} → ${leanTotal} chars  (~${tok(fullTotal)} → ~${tok(leanTotal)} tok, saved ~${tok(fullTotal - leanTotal)} tok/request)`,
);
console.log(`${unchanged}/${rows.length} tools unaffected by stripping\n`);

check(
  "stripping actually removes something",
  leanTotal < fullTotal,
  `${fullTotal - leanTotal} chars`,
);
check(
  "and it is worth a setting (>500 tokens per request)",
  tok(fullTotal - leanTotal) > 500,
  `${tok(fullTotal - leanTotal)} tok`,
);
check("no rule line was lost anywhere", rows.every((r) => r.lost === 0));

// The specific claim in the UI, re-measured rather than trusted.
const todo = rows.find((r) => r.name === "TodoWrite");
if (todo)
  console.log(
    `\nUI claim check — TodoWrite: ${todo.full} → ${todo.lean} chars (claim was 9114 → 3288)`,
  );

console.log(failures === 0 ? "\nlean measurement OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
