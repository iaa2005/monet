/**
 * Repos that ship the same skill once per agent.
 *
 * Reported from the app: installing `impeccable` from pbakaus/impeccable failed
 * with "matches 15 folders", and the fifteen are `.agents/`, `.claude/`,
 * `.cursor/`, `.gemini/`, `.github/`, `.grok/`, `.kiro/`, `.opencode/`, `.pi/`,
 * `.qoder/`, `.rovodev/`, `.trae/`, `.trae-cn/`, `.vibe/` and `plugin/`. That is
 * not ambiguity about which skill it is — it is a choice of agent.
 *
 * Measured, because it decides which one is right: the fifteen copies are NOT
 * duplicates. Fourteen distinct versions, and the differences matter —
 *
 *   `.claude` carries `user-invocable`, `argument-hint` and `allowed-tools:
 *   Bash(...)`, which the others drop; and every path inside the instructions is
 *   written for its own folder (`node .cursor/skills/impeccable/scripts/…`).
 *
 * So installing another agent's copy hands the model instructions pointing at a
 * directory that does not exist here. The Claude variant is the one that works,
 * not a preference.
 *
 * The other reported case is different and needs no choice at all:
 * `microsoft-foundry` matched `skills/microsoft-foundry` and
 * `.github/plugins/azure-skills/skills/microsoft-foundry`, and those two files
 * are byte-identical. Ranking settles it — a plain folder beats another agent's.
 */

export interface AgentFolder {
  /** Stable id, matching the icon file name. */
  id: string;
  label: string;
  /** The top-level folder in the repo, `.claude` and the like. */
  dir: string;
}

/**
 * Order is preference, best first.
 *
 * `.monet` first because it is ours — no repo publishes one yet, and when one
 * does it should win. Then `.claude`, which is the format this app actually
 * runs. Then the agent-neutral folders. Everything after that is another
 * agent's copy: installable on request, never the automatic answer.
 */
export const AGENT_FOLDERS: AgentFolder[] = [
  { id: "monet", label: "Code Monet", dir: ".monet" },
  { id: "claude-code", label: "Claude Code", dir: ".claude" },
  { id: "agents", label: "Any agent", dir: ".agents" },
  { id: "cursor", label: "Cursor", dir: ".cursor" },
  { id: "codex", label: "Codex", dir: ".codex" },
  { id: "github-copilot", label: "GitHub Copilot", dir: ".github" },
  { id: "gemini", label: "Gemini", dir: ".gemini" },
  { id: "antigravity", label: "Antigravity", dir: ".antigravity" },
  { id: "windsurf", label: "Windsurf", dir: ".windsurf" },
  { id: "cline", label: "Cline", dir: ".cline" },
  { id: "amp", label: "AMP", dir: ".amp" },
  { id: "clawdbot", label: "ClawdBot", dir: ".clawdbot" },
  { id: "droid", label: "Droid", dir: ".droid" },
  { id: "goose", label: "Goose", dir: ".goose" },
  { id: "grok", label: "Grok", dir: ".grok" },
  { id: "kilo", label: "Kilo", dir: ".kilo" },
  { id: "kiro-cli", label: "Kiro CLI", dir: ".kiro" },
  { id: "opencode", label: "OpenCode", dir: ".opencode" },
  { id: "pi", label: "Pi", dir: ".pi" },
  { id: "qoder", label: "Qoder", dir: ".qoder" },
  { id: "roo", label: "Roo", dir: ".roo" },
  { id: "rovodev", label: "Rovo Dev", dir: ".rovodev" },
  { id: "trae", label: "Trae", dir: ".trae" },
  { id: "trae-cn", label: "Trae CN", dir: ".trae-cn" },
  { id: "vibe", label: "Vibe", dir: ".vibe" },
  { id: "vscode", label: "VS Code", dir: ".vscode" },
  { id: "zed", label: "Zed", dir: ".zed" },
];

const BY_DIR = new Map(AGENT_FOLDERS.map((a) => [a.dir, a]));

/** Which agent's folder a path sits in, or null for an agent-neutral one. */
export function agentOfPath(path: string): AgentFolder | null {
  const top = path.split("/")[0] ?? "";
  return BY_DIR.get(top) ?? null;
}

/**
 * Lower is better. The neutral band sits between our own folders and other
 * agents' so that `skills/x` beats `.github/…/skills/x` — the reported
 * microsoft-foundry case — while `.claude/skills/x` still beats both.
 */
const NEUTRAL = 3;

export function rankPath(path: string): number {
  const agent = agentOfPath(path);
  if (!agent) return NEUTRAL;
  const i = AGENT_FOLDERS.indexOf(agent);
  // The two we prefer keep their index; every other agent lands after neutral.
  return i <= 2 ? i : NEUTRAL + 1 + i;
}

/**
 * Order candidate folders best-first: by rank, then by depth, then by name.
 *
 * Depth breaks ties toward the canonical spot — `skills/x` over
 * `frameworks/shared/skills/x` — and the name keeps it deterministic, because a
 * resolver that picks differently on two runs is worse than one that picks badly.
 */
export function bestFirst(dirs: string[]): string[] {
  return [...dirs].sort(
    (a, b) =>
      rankPath(a) - rankPath(b) ||
      a.split("/").length - b.split("/").length ||
      a.localeCompare(b),
  );
}

/** Do these two candidates tie, so that choosing between them is a guess? */
export function ties(a: string, b: string): boolean {
  return (
    rankPath(a) === rankPath(b) &&
    a.split("/").length === b.split("/").length &&
    // Same rank AND same depth is only a real tie when neither is an agent
    // folder: `.cursor/skills/x` and `.gemini/skills/x` are the same shape, but
    // they are different agents and the preference order already settled it.
    agentOfPath(a) === null &&
    agentOfPath(b) === null
  );
}
