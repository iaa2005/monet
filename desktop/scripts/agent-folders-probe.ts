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
  allAgentFolders,
  bestFirst,
  parseAgentFolders,
  rankPath,
  setExtraAgentFolders,
  ties,
} from "../src/main/skills/agent-folders.js";
import { pickSkillDir } from "../src/main/skills/registry.js";

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

// ── 6b. A vendor prefix on the catalogue's name ───────────────────────
{
  // Reported: nothing installed, "Could not tell which of the 9 skills in that
  // repository vercel-react-best-practices is". The nine folders are the real
  // ones from vercel-labs/agent-skills, and the answer is react-best-practices:
  // claudemarketplaces prefixes the name with the vendor, the repo does not.
  //
  // Note the trap in this list — two folders already START with `vercel`, so a
  // rule that merely looked for the word would have picked one of them.
  const vercel = [
    "skills/composition-patterns",
    "skills/deploy-to-vercel",
    "skills/react-best-practices",
    "skills/react-native-skills",
    "skills/react-view-transitions",
    "skills/vercel-cli-with-tokens",
    "skills/vercel-optimize",
    "skills/web-design-guidelines",
    "skills/writing-guidelines",
  ];
  const r = pickSkillDir(vercel, "vercel-react-best-practices");
  check("a vendor-prefixed name resolves", r.ok, r.ok ? r.dir : r.error);
  check(
    "and to the right folder, not one starting with vercel",
    r.ok && r.dir === "skills/react-best-practices",
    r.ok ? r.dir : "",
  );
  // The other direction is just as real: the same catalogue lists a plain
  // `react-best-practices` whose folder in another repo carries the prefix.
  const back = pickSkillDir(
    ["skills/vercel-react-best-practices", "skills/other"],
    "react-best-practices",
  );
  check(
    "a prefix on the FOLDER resolves too",
    back.ok && back.dir === "skills/vercel-react-best-practices",
    back.ok ? back.dir : back.error,
  );

  // And the part that matters more: it must not match loosely. Each of these
  // would install the wrong skill.
  const nope: [string, string[], string][] = [
    ["a single trailing token is not enough", ["skills/tokens"], "vercel-cli-with-tokens"],
    ["nor a single leading one", ["skills/vercel"], "vercel-optimize"],
    ["three tokens of prefix is too many", ["skills/practices-x-y"], "a-b-c-practices-x-y"],
    ["a shared tail is not a match", ["skills/view-transitions"], "react-view-transitions-extra"],
    ["and neither is a shared word", ["skills/react-native-skills"], "vercel-react-best-practices"],
  ];
  for (const [label, dirs, name] of nope) {
    const x = pickSkillDir([...dirs, "skills/filler-one", "skills/filler-two"], name);
    check(label, !x.ok, x.ok ? `matched ${x.dir}` : "refused");
  }
  // Two equally-near folders is a question, not an answer.
  const two = pickSkillDir(
    ["skills/best-practices", "skills/react-best-practices", "skills/filler"],
    "vercel-react-best-practices",
  );
  check(
    "the closer of two candidates wins on exactness",
    two.ok && two.dir === "skills/react-best-practices",
    two.ok ? two.dir : two.error,
  );
}

// ── 7. Agents published by the catalogue ──────────────────────────────
{
  // The list changes fastest of anything here — one repo already uses six
  // folders that appear on no published list of agents — so it comes from
  // monet-directory. What it must NOT be able to do is reorder.
  const { agents, rejected } = parseAgentFolders([
    { id: "newagent", label: "New Agent", dir: ".newagent" },
    { id: "another", label: "Another", dir: ".another" },
  ]);
  check("a good entry is accepted", agents.length === 2, rejected.join("; "));
  setExtraAgentFolders(agents);
  check("and names its folder", agentOfPath(".newagent/skills/x")?.label === "New Agent");
  check("it appears in the full list", allAgentFolders().length === AGENT_FOLDERS.length + 2);

  // The promise that matters: nothing published can outrank our own folders.
  check(
    "a catalogue agent ranks below Claude",
    rankPath(".newagent/skills/x") > rankPath(".claude/skills/x"),
  );
  check("below a neutral folder too", rankPath(".newagent/skills/x") > rankPath("skills/x"));
  check(
    "and picking still prefers Claude",
    (() => {
      const r = pickSkillDir([".newagent/skills/x", ".claude/skills/x"], "x");
      return r.ok && r.dir === ".claude/skills/x";
    })(),
  );

  // A catalogue entry cannot relabel a built-in, or the promise above would be
  // decided by whoever edits the file.
  setExtraAgentFolders(
    parseAgentFolders([{ id: "fake", label: "Not Claude", dir: ".claude" }]).agents,
  );
  check(
    "it cannot claim .claude",
    agentOfPath(".claude/skills/x")?.id === "claude-code",
    agentOfPath(".claude/skills/x")?.id,
  );
  check("or change its rank", rankPath(".claude/skills/x") === 1, rankPath(".claude/skills/x"));

  const bad = parseAgentFolders([
    { id: "Bad Id", label: "x", dir: ".x" },
    { id: "no-label", dir: ".y" },
    { id: "long-label", label: "l".repeat(41), dir: ".z" },
    { id: "no-dot", label: "x", dir: "plain" },
    { id: "traversal", label: "x", dir: "../../etc" },
    { id: "nested", label: "x", dir: ".a/b" },
    { id: "dupe-a", label: "x", dir: ".dupe" },
    { id: "dupe-b", label: "x", dir: ".dupe" },
    null,
  ]);
  check("only the first of a duplicated folder survives", bad.agents.length === 1, bad.agents.length);
  check("and the rest are each explained", bad.rejected.length === 8, bad.rejected.length);
  check(
    "a traversal dir is refused",
    bad.rejected.some((r) => r.startsWith("traversal:")),
    bad.rejected.join(" | "),
  );

  check("a missing file is no agents", parseAgentFolders(null).agents.length === 0);
  check(
    "the wrapped form is read",
    parseAgentFolders({ agents: [{ id: "w", label: "W", dir: ".w" }] }).agents.length === 1,
  );
  const flood = parseAgentFolders(
    Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, label: "A", dir: `.a${i}` })),
  );
  check("a flood is capped", flood.agents.length === 80, flood.agents.length);

  // Leave the module as the rest of the suite found it.
  setExtraAgentFolders([]);
  check("cleared again", allAgentFolders().length === AGENT_FOLDERS.length);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL AGENT-FOLDER CHECKS PASSED");
process.exit(failures ? 1 : 0);
