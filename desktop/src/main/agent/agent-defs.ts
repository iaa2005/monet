/**
 * Sub-agent definitions ("agent types").
 *
 * A definition gives a sub-agent its own system prompt, an optional tool
 * allow/deny list, and optional model/effort overrides. The Task tool exposes
 * the available types to the model and routes `subagent_type` to one of these;
 * runSubAgent applies it.
 *
 * Sources, later overriding earlier by `type`:
 *   1. built-ins (below)
 *   2. user agents:    <dataDir>/agents/*.md
 *   3. project agents: <workspace>/.claude/agents/*.md
 *
 * File format is markdown with YAML-ish frontmatter, matching the leaked CLI:
 *   ---
 *   name: explore                 # optional; defaults to the filename
 *   description: when to use this # shown to the model for routing
 *   tools: Read, Grep, Glob       # optional allow-list (array or comma list)
 *   disallowedTools: Bash         # optional deny-list
 *   model: sonnet                 # optional model override ("inherit" = parent)
 *   effort: high                  # optional reasoning effort
 *   ---
 *   <the rest is the agent's system prompt>
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { getDataSubdir } from "../data-dir.js";
import type { EffortLevel } from "../provider/types.js";
import { getSubAgentPrompt } from "./prompts-vendor.js";

export interface AgentDefinition {
  type: string;
  description: string;
  systemPrompt: string;
  /** Allow-list of tool names. When set, the sub-agent sees ONLY these. */
  tools?: string[];
  /** Deny-list of tool names, applied after the allow-list. */
  disallowedTools?: string[];
  /** Model override; undefined or "inherit" = use the parent's model. */
  model?: string;
  effort?: EffortLevel;
  source: "built-in" | "user" | "project";
}

const READONLY_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch"];
const EFFORT_VALUES: readonly EffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Built-in agent types, always available. */
const BUILT_INS: AgentDefinition[] = [
  {
    type: "general-purpose",
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Has the full toolset.",
    systemPrompt: getSubAgentPrompt(),
    source: "built-in",
  },
  {
    type: "explore",
    description:
      "Read-only search agent for broad, fan-out exploration — locates code across many files and reports conclusions. Cannot edit.",
    systemPrompt:
      "You are a read-only exploration agent. Search broadly across the codebase to answer the question, then report your conclusions concisely with concrete file paths and line references. You cannot modify files — do not attempt edits; just find and summarize.",
    tools: READONLY_TOOLS,
    source: "built-in",
  },
  {
    type: "plan",
    description:
      "Read-only planning agent that designs an implementation strategy for a task without changing any files.",
    systemPrompt:
      "You are a planning agent. Investigate the relevant code (read-only) and produce a clear, step-by-step implementation plan: the files to change, the approach, key trade-offs, and risks. Do not modify anything — return the plan as your report.",
    tools: [...READONLY_TOOLS, "TodoWrite"],
    source: "built-in",
  },
];

/** Split `---\n…\n---\nbody` into a small frontmatter map + the body. */
function parseFrontmatter(raw: string): {
  data: Record<string, string>;
  body: string;
} {
  const text = raw.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text.trim() };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    if (key) data[key.toLowerCase()] = val;
  }
  return { data, body: (m[2] ?? "").trim() };
}

/** Parse a `tools:`-style value: `[a, b]`, `a, b`, or a single name. */
function parseNameList(val: string | undefined): string[] | undefined {
  if (!val) return undefined;
  const inner = val.replace(/^\[/, "").replace(/\]$/, "");
  const names = inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return names.length ? names : undefined;
}

function parseEffort(val: string | undefined): EffortLevel | undefined {
  if (!val) return undefined;
  const v = val.toLowerCase() as EffortLevel;
  return EFFORT_VALUES.includes(v) ? v : undefined;
}

export function parseAgentFile(
  raw: string,
  filename: string,
  source: "user" | "project",
): AgentDefinition | null {
  const { data, body } = parseFrontmatter(raw);
  const type = (data.name || filename.replace(/\.md$/i, "")).trim();
  if (!type || !body) return null;
  const model = data.model && data.model !== "inherit" ? data.model : undefined;
  return {
    type,
    description: data.description || `Custom agent "${type}".`,
    systemPrompt: body,
    tools: parseNameList(data.tools),
    disallowedTools: parseNameList(data.disallowedtools),
    model,
    effort: parseEffort(data.effort),
    source,
  };
}

function loadFromDir(
  dir: string,
  source: "user" | "project",
): AgentDefinition[] {
  const out: AgentDefinition[] = [];
  try {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      try {
        const def = parseAgentFile(
          readFileSync(join(dir, name), "utf8"),
          name,
          source,
        );
        if (def) out.push(def);
      } catch {
        /* skip unreadable/invalid agent file */
      }
    }
  } catch {
    /* dir unreadable — ignore */
  }
  return out;
}

/**
 * All available agent definitions, later sources overriding earlier by `type`.
 * Best-effort: a missing/broken agents dir just yields the built-ins.
 */
export function loadAgentDefinitions(workspace?: string): AgentDefinition[] {
  const byType = new Map<string, AgentDefinition>();
  for (const def of BUILT_INS) byType.set(def.type.toLowerCase(), def);
  for (const def of loadFromDir(getDataSubdir("agents"), "user"))
    byType.set(def.type.toLowerCase(), def);
  if (workspace)
    for (const def of loadFromDir(join(workspace, ".claude", "agents"), "project"))
      byType.set(def.type.toLowerCase(), def);
  return [...byType.values()];
}

/** Resolve a `subagent_type` to a definition, falling back to general-purpose. */
export function resolveAgentDefinition(
  type: string | undefined,
  workspace?: string,
): AgentDefinition {
  const defs = loadAgentDefinitions(workspace);
  const found = type
    ? defs.find((d) => d.type.toLowerCase() === type.toLowerCase())
    : undefined;
  return (
    found ??
    defs.find((d) => d.type === "general-purpose") ??
    BUILT_INS[0]!
  );
}

/** A prompt-friendly listing of the available agent types for the Task tool. */
export function describeAgentsForPrompt(workspace?: string): string {
  const lines = loadAgentDefinitions(workspace).map(
    (d) => `- ${d.type}: ${d.description}`,
  );
  return `Available agent types:\n${lines.join("\n")}`;
}

/** The read-only built-in agent types (for the manager's reference list). */
export function getBuiltInAgents(): AgentDefinition[] {
  return BUILT_INS;
}

/** Directory holding user (global) agent .md files. */
export function userAgentsDir(): string {
  return getDataSubdir("agents");
}

export function slugifyAgentName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "agent"
  );
}

/** Serialize agent fields to the markdown-with-frontmatter file format. */
export function buildAgentMarkdown(f: {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  /** Raw effort string; validated against EffortLevel when the file is loaded. */
  effort?: string;
}): string {
  const lines = [
    "---",
    `name: ${f.name.trim()}`,
    `description: ${f.description.trim().replace(/\n+/g, " ")}`,
  ];
  if (f.tools && f.tools.length) lines.push(`tools: [${f.tools.join(", ")}]`);
  if (f.model) lines.push(`model: ${f.model}`);
  if (f.effort) lines.push(`effort: ${f.effort}`);
  lines.push("---", "", f.prompt.trim(), "");
  return lines.join("\n");
}
