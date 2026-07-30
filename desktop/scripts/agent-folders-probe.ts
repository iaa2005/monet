/**
 * Choosing a folder when a repo ships one skill per agent.
 *
 * Two failures reported from the app, and neither was real ambiguity:
 *
 *   "impeccable" matches 15 folders  — one copy per agent
 *   "microsoft-foundry" matches 2 folders — byte-identical copies
 *
 * Both folder lists below are the real ones, read from the repositories. The
 * checks are about picking without guessing: our folder first, then a neutral
 * one, then another agent's — and still refusing when the choice really is a
 * coin toss, because installing the wrong skill puts unexpected instructions in
 * front of the model.
 */

import {
  AGENT_FOLDERS,
  agentOfPath,
  bestFirst,
  rankPath,
  ties,
} from "../src/main/agent-folders";
import { pickSkillDir } from "../src/main/skills-registry";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── 1. pbakaus/impeccable, exactly as the repo has it ─────────────────
{
  // Read from the repo: 15 directories holding a SKILL.md, 14 distinct versions
  // of the file. The `.claude` one carries `allowed-tools` and `user-invocable`
  // and writes its script paths as `.claude/skills/impeccable/scripts/…`, so
  // another agent's copy would point the model at a folder we do not have.
  const dirs = [
    ".agents/skills/impeccable",
    ".claude/skills/impeccable",
    ".cursor/skills/impeccable",
    ".gemini/skills/impeccable",
    ".github/skills/impeccable",
    ".grok/skills/impeccable",
    ".kiro/skills/impeccable",
    ".opencode/skills/impeccable",
    ".pi/skills/impeccable",
    ".qoder/skills/impeccable",
    ".rovodev/skills/impeccable",
    ".trae-cn/skills/impeccable",
    ".trae/skills/impeccable",
    ".vibe/skills/impeccable",
    "plugin/skills/impeccable",
  ];
  const r = pickSkillDir(dirs, "impeccable");
  check("it installs instead of failing", r.ok, r.ok ? r.dir : r.error);
  check(
    "and picks the Claude copy, which is the one that works here",
    r.ok && r.dir === ".claude/skills/impeccable",
    r.ok ? r.dir : "",
  );
  check("every copy is offered", r.ok && r.variants?.length === 15, r.ok ? r.variants?.length : 0);
  check(
    "with the picked one first",
    r.ok && r.variants?.[0] === ".claude/skills/impeccable",
    r.ok ? r.variants?.[0] : "",
  );
  // `.agents` is the agent-neutral copy, so it should be the runner-up rather
  // than some alphabetical accident.
  check(
    "the neutral copy comes next",
    r.ok && r.variants?.[1] === ".agents/skills/impeccable",
    r.ok ? r.variants?.[1] : "",
  );
}

// ── 2. microsoft/azure-skills ─────────────────────────────────────────
{
  // The two files are byte-identical, checked. `.github` is GitHub Copilot's
  // folder, so the plain one wins and nothing is lost either way.
  const dirs = [
    ".github/plugins/azure-skills/skills/microsoft-foundry",
    "skills/microsoft-foundry",
  ];
  const r = pickSkillDir(dirs, "microsoft-foundry");
  check("it installs instead of failing", r.ok, r.ok ? r.dir : r.error);
  check(
    "and prefers the plain folder over Copilot's",
    r.ok && r.dir === "skills/microsoft-foundry",
    r.ok ? r.dir : "",
  );
}

// ── 3. Genuine ambiguity is still refused ─────────────────────────────
{
  // Two neutral folders at the same depth. Nothing distinguishes them, the
  // contents may differ, and quietly taking one would be the bug this whole
  // function exists to avoid.
  const r = pickSkillDir(
    ["research/competitor-analysis", "marketing/competitor-analysis"],
    "competitor-analysis",
  );
  check("a real tie is reported, not guessed", !r.ok, r.ok ? r.dir : r.error);
  check(
    "and both are named",
    !r.ok && r.candidates?.length === 2,
    !r.ok ? r.candidates : "",
  );
  // Different depths is not a tie: the shallower is the canonical spot.
  const d = pickSkillDir(["skills/x", "frameworks/shared/skills/x"], "x");
  check("but different depths resolve", d.ok && d.dir === "skills/x", d.ok ? d.dir : d.error);
}

// ── 4. The order itself ───────────────────────────────────────────────
{
  check("our own folder outranks Claude's", rankPath(".monet/skills/x") < rankPath(".claude/skills/x"));
  check("Claude outranks neutral", rankPath(".claude/skills/x") < rankPath("skills/x"));
  check("neutral outranks another agent", rankPath("skills/x") < rankPath(".cursor/skills/x"));
  check("and .agents sits between Claude and plain",
    rankPath(".claude/skills/x") < rankPath(".agents/skills/x") &&
    rankPath(".agents/skills/x") < rankPath("skills/x"));
  // Determinism: the same input must give the same answer every run, or the
  // resolver installs different things on different days.
  const dirs = [".cursor/skills/x", ".gemini/skills/x", ".vibe/skills/x"];
  const once = bestFirst(dirs).join(",");
  const twice = bestFirst([...dirs].reverse()).join(",");
  check("ordering does not depend on input order", once === twice, `${once} vs ${twice}`);
}

// ── 5. Reading an agent off a path ────────────────────────────────────
{
  check("a claude path is claude", agentOfPath(".claude/skills/x")?.id === "claude-code");
  check("a nested copilot path is copilot", agentOfPath(".github/plugins/a/skills/x")?.id === "github-copilot");
  check("a plain path has no agent", agentOfPath("skills/x") === null);
  check("`plugin` is not an agent", agentOfPath("plugin/skills/x") === null);
  // A folder that merely starts with a dot is not automatically an agent.
  check("an unknown dotfolder has no agent", agentOfPath(".secret/skills/x") === null);
  // Two agents must never claim the same folder, or the preference order is a
  // coin toss between them.
  const dirsSeen = new Set(AGENT_FOLDERS.map((a) => a.dir));
  check("no two agents share a folder", dirsSeen.size === AGENT_FOLDERS.length, AGENT_FOLDERS.length);
  const ids = new Set(AGENT_FOLDERS.map((a) => a.id));
  check("and ids are unique", ids.size === AGENT_FOLDERS.length);
  check(
    "every folder is a dot-folder",
    AGENT_FOLDERS.every((a) => a.dir.startsWith(".")),
    AGENT_FOLDERS.filter((a) => !a.dir.startsWith(".")).map((a) => a.dir).join(","),
  );
}

// ── 6. ties() only fires where a choice is genuinely arbitrary ────────
{
  check("two neutral siblings tie", ties("a/x", "b/x"));
  check("two agent folders do not", !ties(".cursor/skills/x", ".gemini/skills/x"));
  check("different depths do not", !ties("skills/x", "a/b/skills/x"));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL AGENT-FOLDER CHECKS PASSED");
process.exit(failures ? 1 : 0);
