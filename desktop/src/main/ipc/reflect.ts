/**
 * Reflect IPC — an LLM-written monthly digest of the user's sessions
 * (headline, narrative, time categories, AI-fluency skill cards). Numbers and
 * the chart come from the existing stats:get; this endpoint only produces the
 * qualitative part, cached until the session set changes (or force-refresh).
 */

import { ipcMain } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import { getSessionStore } from "../session-store.js";
import { createAdapter } from "../llm/adapter.js";
import { getProviderManager } from "../provider/manager.js";

export interface ReflectDigest {
  headline: string;
  narrative: string;
  categories: { name: string; pct: number; detail: string }[];
  skills: {
    delegation: { title: string; body: string };
    description: { title: string; body: string };
    discernment: { title: string; body: string };
    diligence: { title: string; body: string };
  };
}

const cacheFile = (): string => join(getDataDir(), "reflect-cache.json");

const SYSTEM = `You write a reflective monthly digest of a user's AI-assistant sessions, in the USER'S language (detect it from the chat titles).

Reply with ONLY JSON (no fences):
{"headline": "5-9 word evocative title, like an essay heading",
 "narrative": "4-6 sentence paragraph: what the period was about, how the user worked with the assistant",
 "categories": [{"name": "…", "pct": 32, "detail": "one line of concrete examples"} — 3-5 items, pct sums to ~100],
 "skills": {
   "delegation": {"title": "one-sentence insight", "body": "2-3 sentences of evidence"},
   "description": {"title": "…", "body": "…"},
   "discernment": {"title": "…", "body": "…"},
   "diligence": {"title": "…", "body": "…"}}}

Skill lenses: delegation = what they hand off vs keep; description = how they
give context; discernment = how they verify outputs; diligence = rigour/
traceability. Ground everything in the actual titles; never invent specifics.`;

async function generateDigest(days: number): Promise<ReflectDigest> {
  const provider = getProviderManager().getActive();
  if (!provider) throw new Error("No active provider configured.");
  const since = Date.now() - days * 86_400_000;
  const sessions = getSessionStore()
    .list(300, 0)
    .filter((s) => new Date(s.updatedAt).getTime() >= since);
  if (sessions.length === 0)
    throw new Error("No conversations in this period yet.");
  const lines = sessions
    .slice(0, 120)
    .map(
      (s) =>
        `- [${String(s.updatedAt).slice(0, 10)}] "${s.title}" (${s.space ?? "home"}, ${s.messageCount} msgs)`,
    )
    .join("\n");
  const adapter = createAdapter(provider);
  const res = await adapter.complete({
    model: provider.model,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Sessions of the last ${days} days:\n${lines}`,
      },
    ],
    max_tokens: 1_600,
  });
  const raw = (typeof res.content === "string" ? res.content : "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Digest generation failed.");
  return JSON.parse(raw.slice(start, end + 1)) as ReflectDigest;
}

export function registerReflectIPC(): void {
  ipcMain.handle(
    "reflect:digest",
    async (
      _e,
      days: number,
      force?: boolean,
    ): Promise<{ ok: boolean; digest?: ReflectDigest; error?: string }> => {
      try {
        // Persist per range and reuse for 24h — reopening Settings must NOT
        // regenerate (active chats change constantly). Refresh = force.
        type Entries = Record<string, { at: number; digest: ReflectDigest }>;
        let entries: Entries = {};
        if (existsSync(cacheFile())) {
          try {
            const c = JSON.parse(readFileSync(cacheFile(), "utf-8")) as {
              entries?: Entries;
            };
            entries = c.entries ?? {};
          } catch {
            /* regenerate */
          }
        }
        const hit = entries[String(days)];
        if (!force && hit && Date.now() - hit.at < 24 * 3_600_000)
          return { ok: true, digest: hit.digest };
        const digest = await generateDigest(days);
        entries[String(days)] = { at: Date.now(), digest };
        writeFileSync(cacheFile(), JSON.stringify({ entries }));
        return { ok: true, digest };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "digest failed",
        };
      }
    },
  );
}
