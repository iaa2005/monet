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


import { APP_NAME, DOT_DIR } from "@shared/brand.js";
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
  { id: "monet", label: APP_NAME, dir: DOT_DIR },
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

/**
 * Agents published by the catalogue rather than shipped here.
 *
 * "Всё, что может меняться, переносится в репо", and this list changes fastest of
 * anything in the feature — one repository already ships fifteen, six of which
 * (.grok, .pi, .qoder, .rovodev, .trae-cn, .vibe) appear on no published list of
 * agents. Naming a new one should not need a release.
 *
 * What the catalogue CANNOT do is reorder: every entry from it ranks after every
 * built-in, so no file on the network can make the app prefer another agent's
 * copy over ours. It can only give a folder a name and an icon.
 */
let extra: AgentFolder[] = [];
const EXTRA_BY_DIR = new Map<string, AgentFolder>();

export function setExtraAgentFolders(list: AgentFolder[]): void {
  // A built-in always wins its own folder — otherwise the catalogue could
  // relabel `.claude`, and the ranking promise above would stop being true.
  extra = list.filter((a) => !BY_DIR.has(a.dir));
  EXTRA_BY_DIR.clear();
  for (const a of extra) EXTRA_BY_DIR.set(a.dir, a);
}

/** Every agent the app can name, built-ins first. */
export function allAgentFolders(): AgentFolder[] {
  return [...AGENT_FOLDERS, ...extra];
}

/** Which agent's folder a path sits in, or null for an agent-neutral one. */
export function agentOfPath(path: string): AgentFolder | null {
  const top = path.split("/")[0] ?? "";
  return BY_DIR.get(top) ?? EXTRA_BY_DIR.get(top) ?? null;
}

/**
 * Read a published agent list. Data only — id, label, folder: no markup, no
 * pattern, nothing executable, so there is nothing to sanitise beyond shape.
 */
export function parseAgentFolders(raw: unknown): {
  agents: AgentFolder[];
  rejected: string[];
} {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { agents?: unknown })?.agents)
      ? (raw as { agents: unknown[] }).agents
      : [];
  const agents: AgentFolder[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (agents.length >= 80) {
      rejected.push("over the limit of 80 agents");
      break;
    }
    const e = (entry ?? {}) as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    const label = typeof e.label === "string" ? e.label : "";
    const dir = typeof e.dir === "string" ? e.dir : "";
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
      rejected.push(`${id || JSON.stringify(entry).slice(0, 30)}: id must be kebab-case`);
      continue;
    }
    if (!label || label.length > 40) {
      rejected.push(`${id}: label must be 1-40 characters`);
      continue;
    }
    // A single dot-folder, no traversal. This string is only ever compared with
    // the first segment of a repo path and never reaches the filesystem, but a
    // published list of agents is not where you want to find out that changed.
    if (!SAFE_DIR.test(dir) || dir.includes("..")) {
      rejected.push(`${id}: dir must be a single dot-folder, got ${JSON.stringify(dir)}`);
      continue;
    }
    if (seen.has(dir)) {
      rejected.push(`${id}: ${dir} is already claimed`);
      continue;
    }
    seen.add(dir);
    agents.push({ id, label, dir });
  }
  return { agents, rejected };
}

/**
 * Lower is better. The neutral band sits between our own folders and other
 * agents' so that `skills/x` beats `.github/…/skills/x` — the reported
 * microsoft-foundry case — while `.claude/skills/x` still beats both.
 */
const NEUTRAL = 3;

/** One dot-folder segment: `.claude`, `.trae-cn`. Not a path. */
const SAFE_DIR = /^\.[a-z0-9][a-z0-9._-]{0,38}$/i;

export function rankPath(path: string): number {
  const agent = agentOfPath(path);
  if (!agent) return NEUTRAL;
  const i = AGENT_FOLDERS.indexOf(agent);
  // Not built in, so it came from the catalogue and ranks after every built-in.
  // This is what stops a published list promoting another agent over ours.
  if (i < 0)
    return (
      NEUTRAL + 1 + AGENT_FOLDERS.length + extra.findIndex((a) => a.dir === agent.dir)
    );
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
