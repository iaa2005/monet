/**
 * Daily memory log — the append-only tier of the memory system.
 *
 * Nothing rewrites a memory file mid-conversation any more. Durable-looking
 * signal from a finished turn is appended as a timestamped bullet to
 * `logs/YYYY/MM/YYYY-MM-DD.md`; the nightly pass (consolidate.ts) is what
 * distils those logs into memory files and the MEMORY.md index.
 *
 * Why append-only: the per-turn pass is a cheap model looking at an 8K excerpt,
 * and it used to emit a full REPLACEMENT body for each file it touched — one
 * bad turn could quietly drop months of accumulated facts. Appending can't
 * clobber anything; the worst a bad line does is get ignored at night.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";
import { dirname, join } from "path";
import { getMemoryDir } from "./store.js";

/** Root of the log tree. */
export function logsRoot(): string {
  return join(getMemoryDir(), "logs");
}

/** `logs/YYYY/MM/YYYY-MM-DD.md` for a date, in LOCAL time (the user's day). */
export function dailyLogPath(d: Date = new Date()): string {
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return join(logsRoot(), y, m, `${y}-${m}-${day}.md`);
}

/** `- HH:MM — text` bullets appended under a `# YYYY-MM-DD` heading. */
export function appendDailyLog(bullets: string[], when: Date = new Date()): number {
  const clean = bullets
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter((b) => b.length > 0)
    .map((b) => (b.length > 500 ? b.slice(0, 500) + "…" : b));
  if (clean.length === 0) return 0;

  const file = dailyLogPath(when);
  mkdirSync(dirname(file), { recursive: true });
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");

  let out = "";
  if (!existsSync(file)) {
    const date = file.slice(-13, -3); // YYYY-MM-DD from the filename
    out += `# ${date}\n\n`;
  }
  out += clean.map((b) => `- ${hh}:${mm} — ${b}\n`).join("");
  appendFileSync(file, out, "utf-8");
  return clean.length;
}

/** Every log file, oldest first. */
function allLogFiles(): string[] {
  const root = logsRoot();
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (e.endsWith(".md")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

export interface LogSlice {
  /** Concatenated log text, newest days last, capped. */
  text: string;
  /** How many day-files contributed. */
  files: number;
  /** Total bullets (line count starting with "- "). */
  bullets: number;
}

/**
 * Logs written since `since` (epoch ms). Selection is by file mtime, so a day
 * file that got new bullets after the last consolidation is re-read in full —
 * cheap, and it keeps a partially-consumed day from being half-forgotten.
 */
export function readLogsSince(since: number, cap = 24_000): LogSlice {
  const files = allLogFiles().filter((f) => {
    try {
      return statSync(f).mtimeMs > since;
    } catch {
      return false;
    }
  });
  let text = "";
  let bullets = 0;
  // Newest last: keep the most recent days when the cap bites, so trim from the
  // front rather than truncating the tail.
  for (const f of files) {
    try {
      const raw = readFileSync(f, "utf-8");
      bullets += (raw.match(/^- /gm) ?? []).length;
      text += raw.trimEnd() + "\n\n";
    } catch {
      /* skip unreadable */
    }
  }
  if (text.length > cap) text = "…\n" + text.slice(text.length - cap);
  return { text: text.trim(), files: files.length, bullets };
}

/** Bullets waiting to be consolidated — the "is there new signal?" gate. */
export function pendingBulletCount(since: number): number {
  return readLogsSince(since).bullets;
}
