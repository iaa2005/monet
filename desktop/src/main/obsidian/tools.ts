/**
 * The agent's hands in the vault: VaultSearch, VaultRead, VaultWrite.
 *
 * Everything addresses notes by WIKILINK NAME, not by filesystem path — the
 * vocabulary the vault itself is written in, and the reason the model can
 * follow a [[link]] it just read without translating anything. An ambiguous
 * name (two notes with one basename) comes back as a choice of explicit
 * vault-relative paths rather than a silent pick.
 *
 * Writes are deliberately the narrow door:
 *   - a read-only vault refuses, whatever the mode;
 *   - the write is atomic (tmp + rename) because vaults live in cloud-sync
 *     folders and a half-written file is a conflict copy waiting to happen;
 *   - the tool is not read-only, so the permission layer treats it like any
 *     other write outside the workspace — in every mode short of bypass,
 *     the user sees it. The user's knowledge base is theirs; the protocol
 *     (obsidian/prompt.ts) additionally tells the model to save only when
 *     asked to.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { renameSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { z } from "zod/v4";
import { buildTool } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import {
  allNotes,
  backlinksTo,
  resolveNote,
  searchNotes,
  type IndexedNote,
} from "./index.js";
import { composeNote } from "./notes.js";
import { enabledVaults, getVault } from "./vaults.js";

interface Output {
  text: string;
  isError?: boolean;
}

const asResult = (content: Output, toolUseID: string): ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: toolUseID,
  content: content.text,
  ...(content.isError ? { is_error: true } : {}),
});

const ambiguity = (candidates: IndexedNote[]): Output => ({
  text:
    `That name matches ${candidates.length} notes — address one by its path:\n` +
    candidates.map((c) => `- ${c.relPath} (vault: ${c.vaultName})`).join("\n"),
  isError: true,
});

function noteLine(n: IndexedNote, snippet?: string): string {
  const tags = n.tags.length ? ` #${n.tags.slice(0, 4).join(" #")}` : "";
  const hint = snippet || n.firstLine;
  return `- [[${n.name}]] (${n.vaultName}: ${n.relPath})${tags}${hint ? ` — ${hint}` : ""}`;
}

// ─── VaultSearch ────────────────────────────────────────────────────────

const searchSchema = lazySchema(() =>
  z.strictObject({
    query: z
      .string()
      .describe(
        'Words to find (name, alias, tag or full text). Filters: "tag:project" (by tag), "link:Note Name" (notes that link TO that note). Filters compose with words.',
      ),
    vault: z.string().optional().describe("Limit to one vault, by name."),
    limit: z.number().int().positive().max(50).optional(),
  }),
);
type SearchSchema = ReturnType<typeof searchSchema>;

export const VaultSearchTool = buildTool({
  name: "VaultSearch",
  searchHint: "search the user's Obsidian vaults",
  maxResultSizeChars: 12_000,
  get inputSchema(): SearchSchema {
    return searchSchema();
  },
  userFacingName() {
    return "VaultSearch";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return [
      "Search the user's Obsidian vault(s) — their personal knowledge base of",
      "linked Markdown notes. Matches note names, aliases, tags and full text.",
      "Use `tag:x` to filter by tag and `link:Note Name` to find notes that",
      "link to a note. ALWAYS search before answering questions the vault",
      "might cover, and before creating a note that might already exist.",
    ].join("\n");
  },
  async description() {
    return "Search the user's Obsidian vaults.";
  },
  async call({ query, vault, limit }: z.infer<SearchSchema>) {
    try {
      const notes = allNotes(vault);
      if (notes.length === 0)
        return {
          data: {
            text: vault
              ? `No notes found — is there an enabled vault named "${vault}"?`
              : "No enabled vaults with notes. The user can add one in Settings → Obsidian.",
          },
        };
      const hits = searchNotes(query, notes, limit ?? 20);
      if (hits.length === 0)
        return { data: { text: `Nothing in the vault matches "${query}".` } };
      return {
        data: {
          text:
            `${hits.length} note(s) matching "${query}":\n` +
            hits.map((h) => noteLine(h.note, h.snippet)).join("\n"),
        },
      };
    } catch (err) {
      return {
        data: {
          text: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      };
    }
  },
  mapToolResultToToolResultBlockParam: asResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── VaultRead ──────────────────────────────────────────────────────────

const READ_CAP = 40_000;

const readSchema = lazySchema(() =>
  z.strictObject({
    note: z
      .string()
      .describe(
        "The note's name as a wikilink addresses it (no [[ ]] needed), or a vault-relative path when the name is ambiguous.",
      ),
    vault: z.string().optional().describe("Limit to one vault, by name."),
  }),
);
type ReadSchema = ReturnType<typeof readSchema>;

export const VaultReadTool = buildTool({
  name: "VaultRead",
  searchHint: "read a note from the user's Obsidian vault",
  maxResultSizeChars: READ_CAP + 4_000,
  get inputSchema(): ReadSchema {
    return readSchema();
  },
  userFacingName() {
    return "VaultRead";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return [
      "Read one note from the user's Obsidian vault by its wikilink name.",
      "Returns the note plus its graph neighbourhood: outgoing links and",
      "backlinks (notes that link here). Follow those links with further",
      "VaultRead calls instead of guessing — the vault is written to be",
      "navigated. Read the 2-3 most relevant notes, not the whole vault.",
    ].join("\n");
  },
  async description() {
    return "Read a note (with links and backlinks) from the vault.";
  },
  async call({ note, vault }: z.infer<ReadSchema>) {
    try {
      const notes = allNotes(vault);
      const res = resolveNote(note, notes);
      if (res.kind === "none")
        return {
          data: {
            text: `No note named "${note}". VaultSearch can find candidates.`,
            isError: true,
          },
        };
      if (res.kind === "many") return { data: ambiguity(res.candidates) };
      const n = res.note;
      const back = backlinksTo(n.name, notes);
      const body =
        n.raw.length > READ_CAP
          ? n.raw.slice(0, READ_CAP) + "\n…[truncated]"
          : n.raw;
      const parts = [
        `# [[${n.name}]] — ${n.vaultName}: ${n.relPath}`,
        body,
        n.links.length
          ? `Outgoing links: ${n.links.map((l) => `[[${l}]]`).join(", ")}`
          : "Outgoing links: none",
        back.length
          ? `Backlinks (notes linking here):\n${back
              .slice(0, 15)
              .map((b) => noteLine(b))
              .join("\n")}`
          : "Backlinks: none",
      ];
      return { data: { text: parts.join("\n\n") } };
    } catch (err) {
      return {
        data: {
          text: `Read failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      };
    }
  },
  mapToolResultToToolResultBlockParam: asResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── VaultWrite ─────────────────────────────────────────────────────────

const writeSchema = lazySchema(() =>
  z.strictObject({
    note: z
      .string()
      .describe(
        'Note name, or a vault-relative path like "projects/Idea.md" to choose a folder or settle an ambiguous name.',
      ),
    content: z.string().describe("Markdown body. Use [[wikilinks]] to connect it to existing notes."),
    mode: z
      .enum(["create", "append", "replace"])
      .describe(
        "create = new note (fails if it exists); append = add to the end of an existing note; replace = rewrite an existing note.",
      ),
    vault: z
      .string()
      .optional()
      .describe("Vault name. Required when several vaults are enabled and the note is new."),
    tags: z.array(z.string()).optional().describe("Frontmatter tags for a new note."),
  }),
);
type WriteSchema = ReturnType<typeof writeSchema>;

/** Atomic write: cloud-sync folders must never see a half-written note. */
function writeNoteFile(absPath: string, text: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.monet-tmp`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, absPath);
}

export const VaultWriteTool = buildTool({
  name: "VaultWrite",
  searchHint: "create or update a note in the user's Obsidian vault",
  maxResultSizeChars: 4_000,
  get inputSchema(): WriteSchema {
    return writeSchema();
  },
  userFacingName() {
    return "VaultWrite";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      "Create or update a note in the user's Obsidian vault. The vault is the",
      "USER'S knowledge base: write only when they asked to save something.",
      "Before create, VaultSearch for an existing note on the topic — append",
      "to it rather than spawning a duplicate. Connect new notes to existing",
      "ones with [[wikilinks]]; an unlinked note is invisible in a vault.",
      "Respect the vault's own conventions (folders, frontmatter, tags) as",
      "seen in the notes you have read.",
    ].join("\n");
  },
  async description() {
    return "Create or update a note in the user's Obsidian vault.";
  },
  async call({ note, content, mode, vault, tags }: z.infer<WriteSchema>) {
    try {
      const enabled = enabledVaults();
      if (enabled.length === 0)
        return { data: { text: "No enabled vaults to write into.", isError: true } };

      const targetVault = vault
        ? enabled.find((v) => v.name.toLowerCase() === vault.toLowerCase() || v.id === vault)
        : enabled.length === 1
          ? enabled[0]
          : undefined;

      const notes = allNotes(targetVault?.id);
      const res = resolveNote(note, notes);

      if (mode === "create") {
        if (res.kind === "one")
          return {
            data: {
              text: `[[${res.note.name}]] already exists (${res.note.relPath}). Use append or replace, or pick another name.`,
              isError: true,
            },
          };
        if (!targetVault)
          return {
            data: {
              text: `Several vaults are enabled — say which one: ${enabled.map((v) => v.name).join(", ")}.`,
              isError: true,
            },
          };
        if (targetVault.readOnly)
          return {
            data: { text: `Vault "${targetVault.name}" is read-only.`, isError: true },
          };
        const rel = /[/\\]/.test(note) || /\.md$/i.test(note)
          ? note.replace(/\\/g, "/").replace(/\.md$/i, "") + ".md"
          : `${note}.md`;
        const text = composeNote({ body: content, tags });
        writeNoteFile(join(targetVault.path, rel), text);
        return {
          data: { text: `Created [[${rel.replace(/\.md$/i, "").split("/").pop()}]] at ${targetVault.name}: ${rel}.` },
        };
      }

      // append / replace need an existing, unambiguous note.
      if (res.kind === "none")
        return {
          data: { text: `No note named "${note}" to ${mode}.`, isError: true },
        };
      if (res.kind === "many") return { data: ambiguity(res.candidates) };
      const target = res.note;
      const owner = getVault(target.vaultId);
      if (!owner || owner.readOnly)
        return {
          data: { text: `Vault "${target.vaultName}" is read-only.`, isError: true },
        };
      const abs = join(owner.path, target.relPath);
      const next =
        mode === "append"
          ? target.raw.replace(/\s*$/, "") + "\n\n" + content.replace(/\s+$/, "") + "\n"
          : content.replace(/\s+$/, "") + "\n";
      writeNoteFile(abs, next);
      return {
        data: {
          text: `${mode === "append" ? "Appended to" : "Replaced"} [[${target.name}]] (${target.vaultName}: ${target.relPath}).`,
        },
      };
    } catch (err) {
      return {
        data: {
          text: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      };
    }
  },
  mapToolResultToToolResultBlockParam: asResult,
  renderToolUseMessage() {
    return null;
  },
});
