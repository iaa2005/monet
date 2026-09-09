/**
 * The skills the app ships with, written into the user's skills folder once.
 *
 * The vendor has its own bundled-skill registry, but it lives under
 * src/vendor/leaked and is not ours to edit. The folder it ALSO reads is
 * `<dataDir>/claude/skills`, so a skill placed there is a real slash command
 * discovered by the same code path as one the user wrote — which is the point:
 * `/create-skill` should be editable, and deletable, like any other.
 *
 * Written once and recorded. Rewriting on every launch would undo an edit, and
 * putting back something the user deleted is worse than not shipping it: the
 * marker carries a version, so a genuinely new revision can ship, and a skill
 * the user removed stays removed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import { prepareSkill, type SkillDraft } from "./skill-authoring.js";

/** Bump when a seeded skill's text genuinely changes. */
const SEED_VERSION = 1;

/**
 * Exported for scripts/measure-prompt-probe.ts, which checks that no rule the
 * Bash tool used to state inline was lost when the recipe moved here — a rule
 * that moved is fine, a rule that vanished is not.
 */
export const SEEDED: SkillDraft[] = [
  {
    name: "create-skill",
    description:
      "Use when the user asks to make a new skill or slash command, or when a procedure they just walked through is worth keeping for next time.",
    body: [
      "Write a new skill with the CreateSkill tool. A skill is a folder holding",
      "`SKILL.md` plus any files it refers to, and its name is the slash command:",
      "`release-notes` becomes `/release-notes`.",
      "",
      "## 1. Find out what it is for",
      "",
      "Ask only what you cannot infer, and ask it once:",
      "",
      "- **When should it fire?** The trigger, in the words the user would use.",
      "- **What are the steps?** In the order they happen.",
      "- **Does it need files?** A script to run, a reference too long to inline.",
      "",
      "If they have just walked you through the procedure in this chat, you",
      "already have the answers — say what you are about to write instead of",
      "asking them again.",
      "",
      "## 2. Write the description first",
      "",
      "It is what the agent matches on, and it decides whether the skill is ever",
      "used at all. Lead with the trigger, not the mechanics:",
      "",
      "- Good: *Use when writing release notes from a range of git commits.*",
      "- Useless: *Release notes helper.*",
      "",
      "## 3. Keep the body short",
      "",
      "Imperative, in order, no preamble. It is loaded into a live context, so",
      "every paragraph costs tokens on the turn it is used. Long reference",
      "material goes in a file the body points at, not in the body.",
      "",
      "## 4. Create it, then show it",
      "",
      "Call CreateSkill. Then tell the user the command name and one line on when",
      "it will fire, so they can correct the trigger while it is fresh.",
      "",
      "Do not use this to record a fact about the user — that is the Remember",
      "tool — and do not write a skill for something the model already does well",
      "without instructions.",
    ].join("\n"),
  },
  {
    // Why this exists as a skill rather than as prompt text: the recipe below
    // is 1,461 tokens, it used to sit inside the Bash tool's description, and
    // it was paid on every turn of every chat whether or not anything was ever
    // committed. The RULES it was mixed in with are short and stayed there —
    // see GIT_SAFETY_PROTOCOL in engine/tools/BashTool/prompt.ts. This is the
    // part that is only wanted on the turn someone asks.
    name: "commit",
    description:
      "Use when the user asks to commit, push, or open a pull request. Carries the message format, the checks to run first, and the gh recipe.",
    body: [
      "The safety rules are in your Bash tool's description and hold whether or",
      "not you got here. This is the procedure, not permission: commit only when",
      "the user asked you to.",
      "",
      "## Look before you write",
      "",
      "In ONE message, in parallel:",
      "",
      "- `git status` — what is untracked and what is staged. Never `-uall`.",
      "- `git diff HEAD` — everything the commit would contain.",
      "- `git log --oneline -10` — this repository's own message style. Follow it",
      "  over any habit of your own.",
      "",
      "Stage by name. `git add -A` and `git add .` are how a `.env` or a 200 MB",
      "binary ends up in history.",
      "",
      "## The message",
      "",
      "Say WHY, in the imperative, in the repository's language. The diff already",
      "says what changed; a message that repeats it has told the reader nothing.",
      "",
      "- One subject line under ~70 characters, no full stop.",
      "- A body when the change needs one: the problem, then the decision. Name",
      "  what you measured rather than what you assumed.",
      "- No emoji unless the log already uses them.",
      "- Never `--no-verify`, never `--amend` on anything already pushed. A",
      "  pre-commit hook that fails means the commit did NOT happen — fix, re-stage,",
      "  and make a NEW commit.",
      "",
      "Pass a multi-line message with a heredoc so the formatting survives:",
      "",
      "```bash",
      "git commit -m \"$(cat <<'EOF'",
      "Subject line",
      "",
      "Body.",
      "EOF",
      ")\"",
      "```",
      "",
      "## After committing",
      "",
      "`git status` again. If it did not commit, say so — do not report success",
      "and move on. If you are on the default branch and the user asked for a",
      "branch, make one before committing, not after.",
      "",
      "## A pull request",
      "",
      "Use `gh` for everything GitHub. First understand the whole branch, not the",
      "last commit: `git log <base>..HEAD` and `git diff <base>...HEAD`.",
      "",
      "Then, in parallel: create the branch if needed, push with `-u`, and",
      "`gh pr create` with a heredoc body — a Summary of what changed and why, and",
      "a Test plan of what you actually ran. Return the PR URL when you are done.",
      "",
      "While you are doing this, stay on git and gh. Verbatim from the rules",
      "these steps used to be printed beside, and checked against them by",
      "scripts/measure-prompt-probe.ts:",
      "",
      "- NEVER run additional commands to read or explore code, besides git bash commands",
      "- NEVER use the TodoWrite or Agent tools",
    ].join("\n"),
  },
  {
    // Same trade as /commit, for the same reason: the format below is 581
    // tokens and it was in the system prompt of every turn in both spaces,
    // for a thing most chats never draw. What stays in the prompt is that
    // the capability EXISTS — a model that does not know it can draw will
    // write a table instead, and no skill catalogue will change its mind.
    name: "chart",
    description:
      "Use before drawing a chart in a reply — line, area, bar or candlestick. Carries the JSON format, when to use a candlestick, and how to chart a file without retyping the numbers.",
    body: [
      "Write a fenced block whose language is `chart`. The fence is what makes",
      "it a chart: three backticks, the word chart, the JSON, three backticks.",
      "Without it you have written JSON at the reader, which is worse than a",
      "table.",
      "",
      "```chart",
      '{ "type": "line", "title": "Revenue", "unit": "USD",',
      '  "labels": ["Q1", "Q2", "Q3"], "data": [12.4, 15.1, 14.8] }',
      "```",
      "",
      "`type` is line, area, bar or candlestick. A single series may sit at the",
      "top level like that; for several use `series: [{ name, data }, …]` and",
      "each gets its own colour.",
      "",
      "## Which chart is honest",
      "",
      "For a SECURITY or any financial instrument — a stock, an index, a",
      "currency pair, a commodity, a crypto asset — use candlestick, not a line,",
      "whenever you have open/high/low/close. A line throws away the day's range",
      "and the gaps, which is most of what a price chart is read for. A line is",
      "right for a single measured quantity over time: a metric, a count, a",
      "temperature.",
      "",
      "## Do not retype the data",
      "",
      "If the rows came from RunPython, write them to a file there and point the",
      "block at it with `src`. A hundred candles is thousands of tokens spent",
      "copying numbers you already have, and every copied number is one you can",
      "get wrong:",
      "",
      "```python",
      "import json, yfinance as yf",
      'df = yf.Ticker("AAPL").history(period="1mo", interval="1h")',
      "json.dump({",
      '  "labels": [d.strftime("%Y-%m-%d %H:%M") for d in df.index],',
      '  "ohlc": df[["Open","High","Low","Close"]].round(2).values.tolist(),',
      '  "volume": df["Volume"].astype(int).tolist(),',
      '}, open("aapl_1h.json", "w"))',
      "```",
      "",
      "then, and note the fence again:",
      "",
      "```chart",
      '{ "type": "candlestick", "title": "AAPL", "name": "Apple Inc.",',
      '  "unit": "USD", "subtitle": "1 month, hourly", "src": "aapl_1h.json" }',
      "```",
      "",
      "`title` is the ticker and `name` is the company — write both; a symbol is",
      "an abbreviation and the chart should not make the reader expand it. The",
      "file holds the rows (labels/ohlc/data/volume); the block says what kind of",
      "chart it is. Inline the numbers only when there are a handful of them.",
      "",
      "Do NOT render a chart to PNG just to show it. Do use a PNG when the user",
      "asked for a FILE.",
    ].join("\n"),
  },
];

function markerFile(): string {
  return join(getDataDir(), "seeded-skills.json");
}

function readMarker(): Record<string, number> {
  try {
    const j = JSON.parse(readFileSync(markerFile(), "utf-8")) as unknown;
    return j && typeof j === "object" ? (j as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * Write any seeded skill this data dir has not seen at this version.
 *
 * Best-effort and silent: a skill that cannot be written is a missing command,
 * not a reason to fail a launch.
 */
export function seedSkills(): void {
  let marker: Record<string, number>;
  try {
    marker = readMarker();
  } catch {
    return;
  }
  let changed = false;

  for (const draft of SEEDED) {
    if (marker[draft.name] === SEED_VERSION) continue;
    const prepared = prepareSkill(draft);
    // A seeded skill that does not pass our own rules is a bug in this file;
    // record nothing and leave the folder alone.
    if (!prepared.ok) continue;

    const dir = join(getDataDir(), "claude", "skills", prepared.slug);
    const file = join(dir, "SKILL.md");
    // Only ever write when there is nothing there. An edited copy is the user's,
    // and a deleted one is a decision — both are recorded so neither is undone.
    try {
      if (!existsSync(file)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, prepared.skillMd, "utf-8");
      }
      marker[draft.name] = SEED_VERSION;
      changed = true;
    } catch {
      /* leave it for the next launch */
    }
  }

  if (!changed) return;
  try {
    writeFileSync(markerFile(), JSON.stringify(marker, null, 2), "utf-8");
  } catch {
    /* it will try again next launch, which is harmless */
  }
}
