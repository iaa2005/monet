/**
 * The vault directive — what the model is told when vaults are connected.
 *
 * Injected into the system prompt ONLY while at least one enabled vault
 * exists (like the voice directive: absent, it costs nothing). It is the
 * protocol that makes vault use "precise": search first, read narrowly,
 * write only on request, link everything. The tool prompts repeat the
 * per-tool halves of these rules; this block is the contract between them.
 *
 * Deliberately small: the vault itself never rides in the prompt — it is a
 * retrieval store, and at 400K words it would not fit anyway. What rides is
 * the map: which vaults exist and how big they are.
 */

import { vaultStats } from "./index.js";
import { enabledVaults } from "./vaults.js";
import { tunablePrompt } from "../prompts/index.js";

const RULES_DEFAULT = [
  "The user's Obsidian vault(s) are connected — their personal knowledge",
  "base of linked Markdown notes. Rules:",
  "- SEARCH FIRST: when a question may touch the user's notes, projects or",
  "  research, VaultSearch before answering from general knowledge.",
  "- READ NARROWLY: VaultRead the 2-3 most relevant notes and follow their",
  "  [[wikilinks]]; never try to ingest the vault wholesale.",
  "- CITE: when an answer draws on notes, name them as [[wikilinks]].",
  "- WRITE ONLY ON REQUEST: the vault is the user's own writing. Create or",
  "  change notes only when asked to save, note down or update something —",
  "  never as a side effect. Prefer appending to an existing note over",
  "  creating a near-duplicate, and always connect new notes with",
  "  [[wikilinks]] so they join the graph instead of floating loose.",
  "- OFFER, DON'T TRANSCRIBE: when the conversation produces something",
  "  clearly worth keeping — a decision, a worked-out idea, a result the",
  "  user will want later — you may offer ONCE to save it to the vault,",
  "  naming the note you would create or extend. Write only after an",
  "  explicit yes; silence or 'no' ends the offer, and conversations are",
  "  never transcribed wholesale.",
].join("\n");

/** Materialise the tunable prompt file even when no vault is enabled yet —
 * the "edit prompts" folder must be complete regardless of configuration. */
export function seedVaultPrompt(): void {
  tunablePrompt("vault-rules", RULES_DEFAULT);
}

/** The system-prompt block, or null when no vault is enabled. */
export function buildVaultPrompt(): string | null {
  const vaults = enabledVaults();
  if (vaults.length === 0) return null;
  const lines = vaults.map((v) => {
    try {
      const s = vaultStats(v);
      return `- "${v.name}": ${s.notes} notes, ${s.tags} tags${v.readOnly ? " (read-only)" : ""}`;
    } catch {
      return `- "${v.name}"${v.readOnly ? " (read-only)" : ""}`;
    }
  });
  return [
    "# Obsidian vaults",
    tunablePrompt("vault-rules", RULES_DEFAULT),
    "Connected:",
    ...lines,
  ].join("\n");
}
