/**
 * The vault index — how the tools find notes without reading everything.
 *
 * Incremental by mtime, rebuilt on demand rather than watched: vaults live
 * in cloud-sync folders where files change under us at any moment, and a
 * watcher on a sync folder is a firehose of half-written states. Instead,
 * every tool call refreshes the index first — a walk that stats files and
 * re-reads only what changed. Thousands of notes stat in milliseconds; the
 * 400K-word vault this design is sized for indexes in well under a second
 * cold and near-zero warm.
 *
 * The index keeps each note's parsed metadata AND its lower-cased text, so
 * full-text search is a linear scan over memory — no worker, no database,
 * and a several-MB ceiling that is fine for the vaults this feature serves.
 * Oversized files (>2 MB) are skipped: that is not a note, it is an export.
 *
 * Resolution follows Obsidian: a wikilink name matches a note's basename or
 * one of its aliases, case-insensitively. Two notes may share a name (in
 * different folders) — resolveNote returns the ambiguity instead of picking
 * silently, and the caller can address by vault-relative path instead.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
  isNoteFile,
  nameKey,
  parseNote,
  SKIP_DIRS,
  type NoteMeta,
} from "./notes.js";
import { enabledVaults, type VaultConfig } from "./vaults.js";

const MAX_NOTE_BYTES = 2 * 1024 * 1024;

export interface IndexedNote extends NoteMeta {
  vaultId: string;
  vaultName: string;
  mtimeMs: number;
  /** Lower-cased body for search. */
  searchText: string;
  /** Raw file text (frontmatter included) for reads. */
  raw: string;
}

interface VaultIndex {
  byPath: Map<string, IndexedNote>;
  scannedAt: number;
}

const indexes = new Map<string, VaultIndex>();

function walk(root: string, dir: string, out: { rel: string; mtimeMs: number }[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(root, full, out);
    else if (st.isFile() && isNoteFile(name) && st.size <= MAX_NOTE_BYTES) {
      out.push({
        rel: full.slice(root.length).replace(/^[\\/]/, "").replace(/\\/g, "/"),
        mtimeMs: st.mtimeMs,
      });
    }
  }
}

/** Bring one vault's index up to date with the disk. */
function refreshVault(vault: VaultConfig): VaultIndex {
  const prev = indexes.get(vault.id) ?? { byPath: new Map(), scannedAt: 0 };
  const found: { rel: string; mtimeMs: number }[] = [];
  walk(vault.path, vault.path, found);
  const next = new Map<string, IndexedNote>();
  for (const f of found) {
    const old = prev.byPath.get(f.rel);
    if (old && old.mtimeMs === f.mtimeMs) {
      next.set(f.rel, old);
      continue;
    }
    try {
      const raw = readFileSync(join(vault.path, f.rel), "utf-8");
      const meta = parseNote(f.rel, raw);
      next.set(f.rel, {
        ...meta,
        vaultId: vault.id,
        vaultName: vault.name,
        mtimeMs: f.mtimeMs,
        searchText: raw.toLowerCase(),
        raw,
      });
    } catch {
      /* unreadable file — absent from the index, visible in none of the tools */
    }
  }
  const fresh = { byPath: next, scannedAt: Date.now() };
  indexes.set(vault.id, fresh);
  return fresh;
}

/** Every indexed note across the enabled vaults (refreshing first). */
export function allNotes(vaultFilter?: string): IndexedNote[] {
  const out: IndexedNote[] = [];
  for (const v of enabledVaults()) {
    if (vaultFilter && v.id !== vaultFilter && v.name.toLowerCase() !== vaultFilter.toLowerCase())
      continue;
    for (const note of refreshVault(v).byPath.values()) out.push(note);
  }
  return out;
}

/** Notes whose wikilinks point AT this name. */
export function backlinksTo(name: string, notes: IndexedNote[]): IndexedNote[] {
  const key = nameKey(name);
  return notes.filter((n) => n.links.some((l) => nameKey(l) === key));
}

export type Resolution =
  | { kind: "one"; note: IndexedNote }
  | { kind: "none" }
  | { kind: "many"; candidates: IndexedNote[] };

/** A wikilink name (or vault-relative path) → the note it means. */
export function resolveNote(ref: string, notes: IndexedNote[]): Resolution {
  const cleaned = ref.trim().replace(/^\[\[|\]\]$/g, "");
  // An explicit path wins outright — it is how ambiguity gets settled. But
  // only something that LOOKS like a path takes this branch: a bare name
  // must go through name resolution, or a root-level note would shadow its
  // duplicates ("Self-Attention" matching Self-Attention.md silently while
  // projects/Self-Attention.md exists).
  if (/[/\\]/.test(cleaned) || /\.md$/i.test(cleaned)) {
    const asPath = cleaned.replace(/\\/g, "/");
    const byPath = notes.find(
      (n) => n.relPath.toLowerCase() === asPath.toLowerCase() ||
        n.relPath.toLowerCase() === `${asPath.toLowerCase()}.md`,
    );
    if (byPath) return { kind: "one", note: byPath };
  }
  const key = nameKey(cleaned);
  const hits = notes.filter(
    (n) => nameKey(n.name) === key || n.aliases.some((a) => nameKey(a) === key),
  );
  if (hits.length === 1) return { kind: "one", note: hits[0] };
  if (hits.length === 0) return { kind: "none" };
  return { kind: "many", candidates: hits };
}

export interface SearchHit {
  note: IndexedNote;
  /** A line of context around the first match ("" for name/tag hits). */
  snippet: string;
  score: number;
}

/**
 * One search over names, aliases, tags and full text.
 *
 * `tag:foo` filters by tag; `link:Name` finds notes linking to Name. Both
 * compose with free words. Scoring is deliberately simple: name matches
 * outrank tag matches outrank body matches, ties broken by recency —
 * explainable beats clever in a tool a model drives blind.
 */
export function searchNotes(
  query: string,
  notes: IndexedNote[],
  limit = 20,
): SearchHit[] {
  const terms: string[] = [];
  let tagFilter: string | undefined;
  let linkFilter: string | undefined;
  for (const m of query.matchAll(/(tag|link):("[^"]+"|\S+)|\S+/gi)) {
    const [whole, kind, value] = m;
    if (kind && value) {
      const v = value.replace(/^"|"$/g, "");
      if (kind.toLowerCase() === "tag") tagFilter = v.replace(/^#/, "").toLowerCase();
      else linkFilter = v;
    } else terms.push(whole.toLowerCase());
  }

  const hits: SearchHit[] = [];
  for (const note of notes) {
    if (tagFilter && !note.tags.includes(tagFilter)) continue;
    if (linkFilter && !note.links.some((l) => nameKey(l) === nameKey(linkFilter))) continue;
    let score = 0;
    let snippet = "";
    if (terms.length === 0) {
      // Pure tag:/link: query — every survivor of the filters counts.
      score = 1;
    }
    for (const term of terms) {
      // Exact name beats a name that merely contains the word — searching
      // "attention" must put [[Attention]] above [[Self-Attention]].
      if (nameKey(note.name) === term) score += 25;
      else if (nameKey(note.name).includes(term)) score += 10;
      else if (note.aliases.some((a) => nameKey(a).includes(term))) score += 8;
      else if (note.tags.some((t) => t.includes(term))) score += 5;
      else {
        const at = note.searchText.indexOf(term);
        if (at < 0) {
          score = 0;
          break; // every free word must match somewhere
        }
        score += 1;
        if (!snippet) {
          const start = note.raw.lastIndexOf("\n", at) + 1;
          const end = note.raw.indexOf("\n", at + term.length);
          snippet = note.raw.slice(start, end < 0 ? undefined : end).trim().slice(0, 160);
        }
      }
    }
    if (score > 0) hits.push({ note, snippet, score });
  }
  hits.sort((a, b) => b.score - a.score || b.note.mtimeMs - a.note.mtimeMs);
  return hits.slice(0, limit);
}

/** Vault statistics for the settings UI and the directive. */
export function vaultStats(vault: VaultConfig): { notes: number; links: number; tags: number } {
  const idx = refreshVault(vault);
  let links = 0;
  const tags = new Set<string>();
  for (const n of idx.byPath.values()) {
    links += n.links.length;
    for (const t of n.tags) tags.add(t);
  }
  return { notes: idx.byPath.size, links, tags: tags.size };
}
