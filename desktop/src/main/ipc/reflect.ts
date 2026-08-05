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
import { getSessionStore } from "../session/store.js";
import { createAdapter } from "../llm/adapter.js";
import { getProviderManager } from "../provider/manager.js";
import { resolveBackgroundModel } from "../provider/routing.js";
import { buildMemoryPrompt } from "../memory/store.js";
import { extractJson } from "../llm/json-extract.js";

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
  const routed = resolveBackgroundModel();
  if (!routed) throw new Error("No active provider configured.");
  const provider = routed.provider;
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

  // Long-term memory grounds the digest: session titles alone say WHAT the user
  // did; memory says WHO they are and what they're building, so the narrative
  // and skill cards can be specific instead of guessing from titles.
  const memory = buildMemoryPrompt();
  const memorySection = memory
    ? `\n\nWhat you already know about this user (from memory — weave it in, don't quote it):\n${memory.slice(0, 4_000)}`
    : "";

  const adapter = createAdapter(provider);
  let res;
  try {
    res = await adapter.complete({
      model: routed.model,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Sessions of the last ${days} days:\n${lines}${memorySection}`,
        },
      ],
      // Reasoning models (deepseek-reasoner) spend part of the budget on
      // thinking BEFORE emitting the JSON — 1600 was enough for a chat model
      // but could leave nothing for the answer. Give it room.
      // A Cyrillic digest (narrative + categories + 4 skill cards) is long, and
      // a thinking model spends part of the budget before writing any of it.
      max_tokens: 16_000,
    });
  } catch (e) {
    // Surface the provider's own words (bad key, 402, wrong endpoint) instead
    // of a generic failure — this is where "deepseek fails" actually lands.
    throw new Error(
      `${provider.name || "The model"} couldn't be reached: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const raw = (typeof res.content === "string" ? res.content : "").trim();
  if (!raw)
    // A reasoning model that spent its whole budget thinking returns empty
    // text; the fix is a bigger max_tokens (above) or a non-reasoning model.
    throw new Error(
      `${provider.name || "The model"} returned an empty response. If it's a reasoning model, try a larger context or a non-reasoning model for the digest.`,
    );

  const { value, truncated } = extractJson(raw);
  if (!value)
    throw new Error(
      truncated
        ? `${provider.name || "The model"} ran out of output budget before finishing the digest (${raw.length} chars). Try Refresh, or pick a model with a larger output limit.`
        : `Couldn't read a digest from ${provider.name || "the model"}'s reply. It answered with prose instead of JSON — try Refresh, or a stronger model. First 200 chars: ${raw.slice(0, 200)}`,
    );
  // A salvaged digest can be missing the tail (skills, or some categories).
  // Filling the gaps beats telling the user it failed when the headline and
  // narrative — the parts they actually read — arrived intact.
  return fillDigest(value as Partial<ReflectDigest>);
}

/**
 * Make a possibly-partial digest safe to render.
 *
 * The reply is emitted headline → narrative → categories → skills, so a
 * truncated one loses the tail first. The user reads the headline and the
 * narrative; showing those with a note beats failing the whole digest because
 * the fourth skill card never arrived.
 */
function fillDigest(d: Partial<ReflectDigest>): ReflectDigest {
  const card = (
    v: { title?: unknown; body?: unknown } | undefined,
    fallback: string,
  ): { title: string; body: string } => ({
    title: typeof v?.title === "string" && v.title ? v.title : fallback,
    body: typeof v?.body === "string" ? v.body : "",
  });
  const s = d.skills;
  return {
    headline: typeof d.headline === "string" ? d.headline : "",
    narrative: typeof d.narrative === "string" ? d.narrative : "",
    categories: Array.isArray(d.categories)
      ? d.categories.filter(
          (c): c is ReflectDigest["categories"][number] =>
            !!c && typeof c.name === "string",
        )
      : [],
    skills: {
      delegation: card(s?.delegation, "Delegation"),
      description: card(s?.description, "Description"),
      discernment: card(s?.discernment, "Discernment"),
      diligence: card(s?.diligence, "Diligence"),
    },
  };
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
