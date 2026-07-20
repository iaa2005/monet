import { getSystemPrompt } from "@vendor/constants/prompts.js";
import { getVendorToolsForSpace } from "../src/main/agent/vendor-tools.js";
import { initVendorRuntime } from "../src/main/agent/vendor-context.js";
import { stripExamples } from "../src/main/agent/lean-context.js";

const tok = (s: string): number => Math.ceil(s.length / 4);
const RULE = /\b(NEVER|ALWAYS|IMPORTANT|CRITICAL|do not|don't|must not)\b/i;

async function main(): Promise<void> {
  initVendorRuntime();
  const memoryOff = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1";
  const tools = getVendorToolsForSpace("code");
  const sections = (
    await getSystemPrompt(tools as never, "claude-opus-4-6")
  ).filter(Boolean) as string[];
  const prompt = sections.join("\n\n");

  let full = 0;
  let lean = 0;
  let lost = 0;
  for (const t of tools) {
    let p = "";
    try {
      p = (await (t as never as { prompt?: () => Promise<string> }).prompt?.()) ?? "";
    } catch {
      continue;
    }
    const l = stripExamples(p);
    full += p.length;
    lean += l.length;
    const after = new Set(l.split("\n").map((x) => x.trim()));
    lost += p
      .split("\n")
      .filter((x) => RULE.test(x))
      .map((x) => x.trim())
      .filter((x) => !after.has(x)).length;
  }

  console.log(`vendor auto-memory : ${memoryOff ? "OFF" : "ON"}`);
  console.log(`system prompt      : ${tok(prompt)} tok`);
  console.log(`tools (full)       : ${Math.ceil(full / 4)} tok`);
  console.log(`tools (lean)       : ${Math.ceil(lean / 4)} tok`);
  console.log(
    `TOTAL              : ${tok(prompt) + Math.ceil(lean / 4)} tok before the user's first word`,
  );
  console.log(lost === 0 ? "rules preserved    : yes" : `RULES LOST         : ${lost}`);
}

void main();
