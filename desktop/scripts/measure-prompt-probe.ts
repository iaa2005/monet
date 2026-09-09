/**
 * What a request costs before the user has typed anything.
 *
 * Every diet in this app has to be measured on the real prompt and the real
 * toolset, because the intuitions are all wrong: "Lean tool descriptions" is
 * on by default and Bash is still the largest single item, since its bulk is
 * not examples but two protocols; the schemas cost more than half of what the
 * descriptions do, and nobody looks at schemas.
 *
 *   npm run measure:prompt
 *
 * Prints per SECTION of the system prompt and per TOOL, both halves of each
 * tool (its description and its JSON schema), for both spaces. Tokens are
 * chars/4 — the same estimate the app's own context meter uses, so the two
 * numbers can be compared; it under-counts Russian by roughly half.
 *
 * The last line is the guard: every NEVER / IMPORTANT / CRITICAL line that
 * lean mode drops is counted. Trimming is allowed to lose examples. It is not
 * allowed to lose a prohibition.
 *
 * The toolset depends on configuration — a vault enabled, LSP on, connectors
 * attached — so `MONET_DATA_DIR=…` in front of the command measures a
 * particular install rather than the default one. Compare like with like when
 * quoting a before and an after.
 */

import { getSystemPrompt } from "@main/engine/constants/prompts.js";
import {
  getVendorApiTools,
  getVendorToolsForSpace,
} from "@main/agent/vendor-tools.js";
import { initVendorRuntime } from "@main/agent/vendor-context.js";
import { stripExamples } from "@main/agent/lean-context.js";

const tok = (s: string): number => Math.ceil(s.length / 4);
const RULE = /\b(NEVER|ALWAYS|IMPORTANT|CRITICAL|do not|don't|must not)\b/i;
const pad = (n: number | string, w: number): string => String(n).padStart(w);

/** The first line with anything on it — a section's own heading. */
function headline(section: string): string {
  const line = section.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

async function measure(space: "code" | "home"): Promise<number> {
  const tools = getVendorToolsForSpace(space);
  const sections = (
    await getSystemPrompt(tools as never, "claude-opus-4-6")
  ).filter(Boolean) as string[];

  console.log(`\n══ ${space.toUpperCase()} ═══════════════════════════════════`);
  console.log("\nsystem prompt, by section");
  let systemTotal = 0;
  for (const s of sections) {
    console.log(`  ${pad(tok(s), 6)}  ${headline(s)}`);
    systemTotal += tok(s);
  }
  console.log(`  ${pad(systemTotal, 6)}  ── total`);

  // The tools AS SENT: descriptions already through lean mode, schemas as
  // the API will see them. Measuring the raw prompt() instead is how a diet
  // gets credited twice for something lean mode had already removed.
  const api = await getVendorApiTools(space);
  const rows = api
    .map((t) => ({
      name: t.name,
      desc: tok(t.description ?? ""),
      schema: tok(JSON.stringify(t.input_schema ?? {})),
    }))
    .sort((a, b) => b.desc + b.schema - (a.desc + a.schema));

  console.log(`\ntools, by cost   (${rows.length} advertised)`);
  console.log("     desc  schema  name");
  let desc = 0;
  let schema = 0;
  for (const r of rows) {
    console.log(`  ${pad(r.desc, 6)}  ${pad(r.schema, 6)}  ${r.name}`);
    desc += r.desc;
    schema += r.schema;
  }
  console.log(`  ${pad(desc, 6)}  ${pad(schema, 6)}  ── total ${desc + schema}`);

  const total = systemTotal + desc + schema;
  console.log(`\n  TOTAL ${space}: ${total} tok before the user's first word`);
  return total;
}

async function main(): Promise<void> {
  initVendorRuntime();
  console.log(
    `vendor auto-memory: ${
      process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1" ? "OFF" : "ON"
    }   (main sets it OFF at startup — see agent/lean-context.ts)`,
  );

  const code = await measure("code");
  const home = await measure("home");

  // What lean mode costs in rules, not in characters. Run over every tool's
  // own prompt() rather than the advertised description, because that is the
  // text the stripping is applied to.
  let lost = 0;
  for (const t of getVendorToolsForSpace("code")) {
    let p = "";
    try {
      p = (await (t as { prompt?: () => Promise<string> }).prompt?.()) ?? "";
    } catch {
      continue;
    }
    const after = new Set(stripExamples(p).split("\n").map((x) => x.trim()));
    lost += p
      .split("\n")
      .filter((x) => RULE.test(x))
      .map((x) => x.trim())
      .filter((x) => !after.has(x)).length;
  }

  console.log("\n═════════════════════════════════════════════════");
  console.log(`code ${code} · home ${home}`);
  console.log(
    lost === 0
      ? "rules preserved by lean mode: yes"
      : `RULES LOST TO LEAN MODE: ${lost}`,
  );
  if (lost > 0) process.exitCode = 1;
}

void main();
