/**
 * The command menu speaks this app's name, and only where it should.
 *
 * The vendor's descriptions are written for the CLI — "Review a pull request
 * with Claude Code", "Set a goal for Claude to work toward" — which is wrong
 * on screen here and wrong in substance: the model answering may be DeepSeek.
 *
 * The risk in fixing it is over-reach, so that is what this pins: "Claude API"
 * is a real product name and CLAUDE.md is a real file the commands write.
 * Renaming either would turn a description into a lie, which is worse than
 * leaving the wrong brand on it.
 *
 *   npm run smoke:cmdbrand
 */

import { readFileSync } from "fs";
import { rebrand } from "@shared/rebrand";
import {
  APP_NAME,
  MEMORY_FILE,
  UPSTREAM_API_NAME,
  UPSTREAM_MEMORY_FILE,
  UPSTREAM_NAME,
} from "@shared/brand";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
    );
  }
}

// ─── What it must change ────────────────────────────────────────────────

{
  const sample = `Initialize a new ${UPSTREAM_MEMORY_FILE} file with ${UPSTREAM_NAME}`;
  check(
    "the product name becomes ours",
    rebrand(sample) === `Initialize a new ${MEMORY_FILE} file with ${APP_NAME}`,
    rebrand(sample),
  );
  const word = UPSTREAM_NAME.split(" ")[0];
  check(
    "a bare vendor word means the agent, which here may not be that vendor",
    rebrand(`Set a goal for ${word} to work toward`) ===
      "Set a goal for the agent to work toward",
    rebrand(`Set a goal for ${word} to work toward`),
  );
  check(
    "…including possessives",
    rebrand(`${word}'s status line`) === "the agent's status line",
    rebrand(`${word}'s status line`),
  );
  // The point of the exercise: a rename is one file. Comments may NAME the
  // things they explain — code may not.
  const rule = readFileSync(
    new URL("../src/shared/rebrand.ts", import.meta.url),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  check(
    "NOTHING IS SPELT OUT IN THE RULE — every name comes from brand.ts",
    !new RegExp(`${UPSTREAM_NAME.split(" ")[0]}|${APP_NAME.split(" ")[1]}`).test(rule),
    rule.match(/.*(Claude|Monet).*/)?.[0],
  );
}

// ─── WHAT IT MUST LEAVE ALONE ───────────────────────────────────────────

{
  check(
    "THE MEMORY FILE BECOMES OURS — it is the one we write when we choose",
    rebrand(`Edit ${UPSTREAM_MEMORY_FILE} files and manage auto memory`) ===
      `Edit ${MEMORY_FILE} files and manage auto memory`,
    rebrand(`Edit ${UPSTREAM_MEMORY_FILE} files and manage auto memory`),
  );
  check(
    "the upstream API is a real product and keeps its name",
    rebrand(`Load ${UPSTREAM_API_NAME} reference material`).includes(
      UPSTREAM_API_NAME,
    ),
    rebrand(`Load ${UPSTREAM_API_NAME} reference material`),
  );
  check(
    "…even beside a rebranded mention",
    rebrand(`${UPSTREAM_NAME} can call the ${UPSTREAM_API_NAME}`) ===
      `${APP_NAME} can call the ${UPSTREAM_API_NAME}`,
    rebrand(`${UPSTREAM_NAME} can call the ${UPSTREAM_API_NAME}`),
  );
  check(
    "text with nothing to change is returned untouched",
    rebrand("Compact this chat's context") === "Compact this chat's context",
  );
}

console.log(
  failures ? `\n${failures} FAILED` : "\nTHE MENU SPEAKS OUR NAME, AND ONLY OURS",
);
process.exit(failures ? 1 : 0);
