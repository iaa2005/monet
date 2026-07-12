/**
 * Agents IPC — manage sub-agent definitions ("agent types") from Settings.
 *
 * User agents live as single markdown files at <dataDir>/agents/<slug>.md
 * (the same location agent-defs.ts loads). Each is YAML frontmatter
 * (name/description/tools/model/effort) + a system-prompt body. Built-in
 * agents are read-only and shown for reference. After a mutation we reset the
 * vendor tool cache so the Task tool's advertised agent list refreshes without
 * an app restart.
 */

import { ipcMain } from "electron";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { writeFileSync } from "fs";
import { join, resolve } from "path";
import {
  buildAgentMarkdown,
  getBuiltInAgents,
  parseAgentFile,
  slugifyAgentName,
  userAgentsDir,
} from "../agent/agent-defs.js";

export interface AgentSummary {
  /** For user agents this is the filename (edit key); for built-ins, the type. */
  slug: string;
  type: string;
  description: string;
  tools?: string[];
  model?: string;
  source: "built-in" | "user";
  editable: boolean;
}

interface AgentCreatePayload {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  effort?: string;
}

function agentFile(slug: string): string | null {
  // A slug maps to exactly <dataDir>/agents/<slug>.md — reject traversal.
  const safe = slug.replace(/\.md$/i, "");
  if (!/^[a-z0-9._-]+$/i.test(safe)) return null;
  const base = resolve(userAgentsDir());
  const full = resolve(join(base, `${safe}.md`));
  return full.startsWith(base) ? full : null;
}

function listUserAgents(): AgentSummary[] {
  const dir = userAgentsDir();
  const out: AgentSummary[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      try {
        const def = parseAgentFile(
          readFileSync(join(dir, name), "utf8"),
          name,
          "user",
        );
        if (def)
          out.push({
            slug: name.replace(/\.md$/i, ""),
            type: def.type,
            description: def.description,
            tools: def.tools,
            model: def.model,
            source: "user",
            editable: true,
          });
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* dir missing — ignore */
  }
  return out.sort((a, b) => a.type.localeCompare(b.type));
}

function refreshAgentCaches(): void {
  // The Task tool's advertised agent list is baked into its cached schema.
  void import("../agent/vendor-tools.js")
    .then((m) => m.resetVendorTools?.())
    .catch(() => {});
}

export function registerAgentsIPC(): void {
  ipcMain.handle("agents:list", (): AgentSummary[] => {
    const builtins: AgentSummary[] = getBuiltInAgents().map((d) => ({
      slug: d.type,
      type: d.type,
      description: d.description,
      tools: d.tools,
      model: d.model,
      source: "built-in",
      editable: false,
    }));
    return [...listUserAgents(), ...builtins];
  });

  ipcMain.handle(
    "agents:create",
    (_e, payload: AgentCreatePayload): AgentSummary => {
      if (!payload?.name?.trim()) throw new Error("Agent name is required");
      if (!payload?.prompt?.trim())
        throw new Error("Agent system prompt is required");
      const slug = slugifyAgentName(payload.name);
      // Names must be unique across built-ins AND existing user agents.
      const taken = new Set<string>();
      for (const d of getBuiltInAgents()) taken.add(d.type.toLowerCase());
      for (const u of listUserAgents()) {
        taken.add(u.slug.toLowerCase());
        taken.add(u.type.toLowerCase());
      }
      if (
        taken.has(slug.toLowerCase()) ||
        taken.has(payload.name.trim().toLowerCase())
      ) {
        throw new Error(
          `An agent named "${payload.name.trim()}" already exists — choose a different name.`,
        );
      }
      const full = agentFile(slug);
      if (!full) throw new Error("Invalid agent name");
      writeFileSync(
        full,
        buildAgentMarkdown({
          name: payload.name,
          description: payload.description ?? "",
          prompt: payload.prompt,
          tools: payload.tools,
          model: payload.model,
          effort: payload.effort,
        }),
        "utf8",
      );
      refreshAgentCaches();
      return {
        slug,
        type: payload.name.trim(),
        description: payload.description ?? "",
        tools: payload.tools,
        model: payload.model,
        source: "user",
        editable: true,
      };
    },
  );

  ipcMain.handle(
    "agents:getRaw",
    (_e, slug: string): { ok: boolean; content?: string; error?: string } => {
      const full = agentFile(slug);
      if (!full || !existsSync(full)) return { ok: false, error: "Not found" };
      try {
        const st = statSync(full);
        if (st.size > 400_000)
          return { ok: false, error: "File is too large" };
        return { ok: true, content: readFileSync(full, "utf8") };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "read failed",
        };
      }
    },
  );

  ipcMain.handle(
    "agents:writeRaw",
    (_e, slug: string, content: string): { ok: boolean; error?: string } => {
      const full = agentFile(slug);
      if (!full) return { ok: false, error: "Invalid path" };
      try {
        writeFileSync(full, content, "utf8");
        refreshAgentCaches();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "write failed",
        };
      }
    },
  );

  ipcMain.handle("agents:delete", (_e, slug: string): { ok: boolean } => {
    const full = agentFile(slug);
    if (full && existsSync(full)) rmSync(full, { force: true });
    refreshAgentCaches();
    return { ok: true };
  });

  // Tool names a sub-agent can be restricted to (for the manager's checkboxes).
  // Excludes Task/Agent (no nesting) and MCP tools (dynamic per connection).
  ipcMain.handle("agents:availableTools", async (): Promise<string[]> => {
    try {
      const { getVendorTools } = await import("../agent/vendor-tools.js");
      return getVendorTools()
        .filter((t) => !t.isMcp && t.name !== "Task" && t.name !== "Agent")
        .map((t) => t.name)
        .sort();
    } catch {
      return [];
    }
  });
}
