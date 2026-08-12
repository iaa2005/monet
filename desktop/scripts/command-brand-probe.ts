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

import { rebrand } from "@shared/rebrand";
import { APP_NAME } from "@shared/brand";

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
  check(
    "the product name becomes ours",
    rebrand("Initialize a new CLAUDE.md file with Claude Code") ===
      `Initialize a new CLAUDE.md file with ${APP_NAME}`,
    rebrand("Initialize a new CLAUDE.md file with Claude Code"),
  );
  check(
    "a bare Claude means the agent, which here may not be Claude at all",
    rebrand("Set a goal for Claude to work toward") ===
      "Set a goal for the agent to work toward",
    rebrand("Set a goal for Claude to work toward"),
  );
  check(
    "…including possessives",
    rebrand("Claude's status line") === "the agent's status line",
    rebrand("Claude's status line"),
  );
}

// ─── WHAT IT MUST LEAVE ALONE ───────────────────────────────────────────

{
  check(
    "CLAUDE.md IS A REAL FILE — renaming it in the text would be a lie",
    rebrand("Edit CLAUDE.md files and manage auto memory").includes("CLAUDE.md"),
    rebrand("Edit CLAUDE.md files and manage auto memory"),
  );
  check(
    "Claude API is a real product and keeps its name",
    rebrand("Load Claude API reference material").includes("Claude API"),
    rebrand("Load Claude API reference material"),
  );
  check(
    "…even beside a rebranded mention",
    rebrand("Claude Code can call the Claude API") ===
      `${APP_NAME} can call the Claude API`,
    rebrand("Claude Code can call the Claude API"),
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
