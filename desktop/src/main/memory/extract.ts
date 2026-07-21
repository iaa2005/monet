/**
 * Memory extraction — a cheap background LLM pass that distils durable facts
 * from a finished turn and merges them into the memory files (full-file
 * replacement per update, so the model rewrites rather than appends dupes).
 * Best-effort and throttled; a failure never surfaces to the user.
 */

import { createAdapter } from "../llm/adapter.js";
import { getProviderManager } from "../provider/manager.js";
import { resolveBackgroundModel } from "../provider/routing.js";
import {
  getMemoryConfig,
  isValidMemoryId,
  listMemoryFiles,
  readMemoryFile,
  slugifyMemoryName,
  writeMemoryFile,
} from "./store.js";

const lastRun = new Map<string, number>();

const SYSTEM = `You maintain the user's long-term memory for an AI assistant.

Memory files (id → purpose):
- "profile" — who the user is: role, field, location, languages, stable preferences.
- "topics/<slug>" — sustained interests or workflows (e.g. topics/latex-workflow).
- "areas/<slug>" — long-running projects (e.g. areas/gost-rag).

You receive CURRENT MEMORY and a RECENT CONVERSATION excerpt. Decide whether it
reveals DURABLE facts worth keeping (identity, preferences, ongoing projects,
recurring workflows). Ignore one-off task details, secrets, and anything the
assistant said about itself.

Reply with ONLY a JSON array (no prose, no code fences) of file updates:
[{"id": "profile" | "topics/<slug>" | "areas/<slug>", "name": "Short Title",
  "summary": "one line", "content": "full REPLACEMENT markdown body"}]
Rules:
- Merge: the content you output REPLACES the file — carry over still-valid
  existing facts, integrate the new ones, drop duplicates and stale items.
- Slugs: lowercase latin + dashes. Reuse an existing file when the subject matches.
- Write names/summaries/content in the user's own language.
- At most 3 updates. If nothing durable: []`;

function currentMemoryBlock(): string {
  const files = listMemoryFiles();
  if (files.length === 0) return "(no memory files yet)";
  return files
    .map((f) => {
      const r = readMemoryFile(f.id);
      const body = (r.body ?? "").slice(0, 1_800);
      return `### id: ${f.id}\nname: ${f.name}\nsummary: ${f.summary}\n${body}`;
    })
    .join("\n\n")
    .slice(0, 9_000);
}

interface Update {
  id: string;
  name: string;
  summary: string;
  content: string;
}

function parseUpdates(raw: string): Update[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (u): u is Update =>
          !!u &&
          typeof (u as Update).id === "string" &&
          typeof (u as Update).content === "string",
      )
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** Run one extraction pass over arbitrary text. Returns applied file ids. */
export async function runExtraction(excerpt: string): Promise<string[]> {
  const provider = getProviderManager().getActive();
  if (!provider) return [];
  const adapter = createAdapter(provider);
  const res = await adapter.complete({
    model: provider.model,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `CURRENT MEMORY:\n${currentMemoryBlock()}\n\nRECENT CONVERSATION:\n${excerpt.slice(0, 8_000)}`,
      },
    ],
    max_tokens: 2_000,
  });
  const raw = typeof res.content === "string" ? res.content : "";
  const applied: string[] = [];
  for (const u of parseUpdates(raw)) {
    // Normalize a sloppy id like "topics/LaTeX Workflow".
    let id = u.id.trim();
    const m = /^(topics|areas)\/(.+)$/.exec(id);
    if (m) id = `${m[1]}/${slugifyMemoryName(m[2])}`;
    if (!isValidMemoryId(id)) continue;
    const r = writeMemoryFile(id, {
      name: u.name || id.split("/").pop() || id,
      summary: u.summary || "",
      body: u.content,
    });
    if (r.ok) applied.push(id);
  }
  return applied;
}

const LOG_SYSTEM = `You watch a conversation between a user and their AI assistant and note what is worth remembering in FUTURE conversations.

Record:
- Corrections and preferences the user states ("use bun, not npm"; "stop summarising diffs")
- Facts about the user: role, field, languages, tools, goals
- Project context not derivable from the code: decisions and their rationale, deadlines, incidents
- Pointers to external systems (dashboards, repos, tickets)
- Anything the user explicitly asks to remember

Do NOT record: secrets or credentials, one-off task mechanics, anything already obvious from the code, or what the assistant said about itself.

Reply with ONLY a JSON array of short self-contained strings, each one fact, in the user's language. Convert "yesterday"/"last week" to absolute dates. At most 5. If nothing is worth remembering: []`;

function parseBullets(raw: string): string[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * The per-turn pass. Appends observations to today's log instead of rewriting
 * memory files: a cheap model looking at an 8K excerpt should never be able to
 * drop facts it can't see. The nightly consolidation is what turns these into
 * memory files, with the whole picture in view.
 */
export async function runLogPass(excerpt: string): Promise<number> {
  // Background work: routed to the cheap/local model when one is configured.
  const routed = resolveBackgroundModel();
  if (!routed) return 0;
  const adapter = createAdapter(routed.provider);
  const res = await adapter.complete({
    model: routed.model,
    system: LOG_SYSTEM,
    messages: [{ role: "user", content: `CONVERSATION:\n${excerpt.slice(0, 8_000)}` }],
    max_tokens: 800,
  });
  const bullets = parseBullets(typeof res.content === "string" ? res.content : "");
  if (bullets.length === 0) return 0;
  const { appendDailyLog } = await import("./daily-log.js");
  return appendDailyLog(bullets);
}

/** Post-turn hook: throttled, gated, fire-and-forget. */
export async function maybeExtractMemory(
  sessionId: string,
  conversationText: string | null,
): Promise<void> {
  try {
    const cfg = getMemoryConfig();
    if (!cfg.generateMemory) return;
    // 0 = "Never": the user doesn't want a request spent after every turn.
    if (cfg.extractEveryMinutes <= 0) return;
    if (!sessionId || sessionId === "default" || sessionId.startsWith("incognito-"))
      return;
    if (!conversationText || conversationText.length < 200) return;
    const now = Date.now();
    if (now - (lastRun.get(sessionId) ?? 0) < cfg.extractEveryMinutes * 60_000)
      return;
    lastRun.set(sessionId, now);
    await runLogPass(conversationText);
  } catch {
    /* memory is best-effort */
  }
}

/** "Tell Code Monet to remember…" from the Memory settings page. */
export async function addMemoryNote(
  note: string,
): Promise<{ ok: boolean; applied: string[] }> {
  try {
    const applied = await runExtraction(
      `The user explicitly asked to remember this:\n${note}\n\n(Store it even if small — pick the most fitting file.)`,
    );
    if (applied.length > 0) return { ok: true, applied };
  } catch {
    /* fall through to the verbatim fallback */
  }
  // LLM unavailable or returned nothing — keep the note verbatim in profile.
  const cur = readMemoryFile("profile");
  writeMemoryFile("profile", {
    name: cur.name || "Profile",
    summary: cur.summary || "Who the user is",
    body: `${cur.body ? cur.body + "\n" : ""}- ${note.trim()}`,
  });
  return { ok: true, applied: ["profile"] };
}
