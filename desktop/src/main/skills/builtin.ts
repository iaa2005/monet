/**
 * Built-in skills — written into the standard skills dir on startup so they
 * show up in Settings → Skills and the "/" menu like any user skill.
 *
 * Idempotent and non-destructive: a skill is only created when its folder
 * does not exist, so user edits (or deletion… well, deletion respawns it on
 * restart — edit the file to neuter it instead) are preserved.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

const SANDBOX_DOCUMENTS_SKILL = `---
name: sandbox-documents
description: Generate polished documents (PDF, DOCX, XLSX, LaTeX) in the Home sandbox — picks the right toolchain for the active sandbox engine.
author: Monet
---

# Generating documents in the Home sandbox

The RunPython tool description states the ACTIVE sandbox engine. Choose the
toolchain accordingly — do not guess, and never fake an output format by
renaming a file.

## Which engine am I in?

Read the first line of the RunPython tool description:
- "PYODIDE" — Python in WebAssembly (no LaTeX, no subprocess, no pip CLI).
- "LOCAL SUBPROCESS" — the user's real Python on their machine.
- "PODMAN CONTAINER" — isolated container with python3, nodejs and tectonic.

## PDF

- PYODIDE: use **fpdf2** (installs automatically on import). For Cyrillic or
  other non-Latin text, embed a Unicode TTF (e.g. DejaVuSans) — fpdf2's core
  fonts are Latin-1 only.
- LOCAL SUBPROCESS: check for a local LaTeX first:
  \`shutil.which('pdflatex')\` (also try 'xelatex', 'tectonic'). If present:
  write report.tex, run it twice via subprocess, check the .pdf exists.
  If absent: fall back to fpdf2 and TELL the user LaTeX wasn't found.
- PODMAN: write report.tex, run \`subprocess.run(['tectonic', 'report.tex'])\`
  — tectonic downloads missing TeX packages automatically on first use.

## Fonts in a PODMAN LaTeX document

tectonic is XeTeX: \`inputenc\`/\`fontenc[T2A]\` do not apply, fontspec does.
The default block — all a document normally needs, and the one that keeps the
text in the same face as the maths tectonic sets on its own:

\`\`\`latex
\\usepackage{fontspec}
\\setmainfont{CMU Serif}
\\setsansfont{CMU Sans Serif}
\\setmonofont{CMU Typewriter Text}
\`\`\`

CMU is Computer Modern Unicode — the classic LaTeX face, with Cyrillic and
Greek. Add \`\\usepackage{polyglossia}\\setmainlanguage{russian}\` for Russian
hyphenation. Never pass \`Path=\` or a .ttf filename; the family name resolves.
DejaVu and Liberation are installed too, for a deliberately different look.

## DOCX / XLSX / PPTX

python-docx / openpyxl / python-pptx work in EVERY engine (auto-installed).
Embed images by filename from the working directory (they persist between
runs). Update fields like a table of contents cannot be recomputed by
python-docx — say so instead of pretending.

## LaTeX sources

When the user wants an editable document, produce the .tex file itself as an
artifact too — the app previews .tex with syntax highlighting.

## Verify before claiming success

After generating, ALWAYS check the file exists and is non-trivial:

\`\`\`python
import os
assert os.path.exists('report.pdf') and os.path.getsize('report.pdf') > 1000
print('OK', os.path.getsize('report.pdf'), 'bytes')
\`\`\`

If generation failed, report the real error — do not silently deliver a
different format than requested. Offer the fallback explicitly.
`;

const WIKI_QUERY_SKILL = `---
name: wiki-query
description: Answer a question strictly from the user's Obsidian vault, citing the notes used — never from general knowledge.
author: Monet
---

# Answering from the vault

The user wants an answer grounded in THEIR notes, not in your general
knowledge. Requires an enabled vault (Settings → Obsidian).

1. Decompose the question into 1-3 searchable ideas.
2. ObsidianSearch each (try tags and \`link:\` filters, not just words).
3. ObsidianRead the top 2-4 notes; follow [[wikilinks]] one hop when a note
   points somewhere clearly more specific.
4. Answer FROM THE NOTES. Every claim cites its note as a [[wikilink]].
5. If the vault does not cover it, say exactly that — name what you searched
   for — and only then offer general knowledge, clearly labelled as such.
`;

const WIKI_INGEST_SKILL = `---
name: wiki-ingest
description: Turn source material (a URL, pasted text, a file) into linked, tagged notes in the user's Obsidian vault.
author: Monet
---

# Ingesting a source into the vault

Turn source material into notes that JOIN the vault's graph instead of
floating loose. Requires a writable vault (Settings → Obsidian).

1. Read the source (WebFetch for a URL, the file tools for a file).
2. ObsidianSearch for existing notes on the topic and for the vault's
   conventions — folder layout, frontmatter style, tag vocabulary. Mirror
   what you find; do not impose your own scheme.
3. Write ONE note per concept, not one note per source dump:
   - a clear name a future [[wikilink]] would naturally use;
   - frontmatter tags from the vault's existing vocabulary;
   - [[wikilinks]] to every related existing note you found in step 2;
   - a "Source" line with the URL/origin — claims stay traceable.
4. Where an existing note already covers a concept, ObsidianWrite append the
   new facts there instead of creating a near-duplicate.
5. Finish with a list of what was created/updated, as [[wikilinks]].
`;

const WIKI_LINT_SKILL = `---
name: wiki-lint
description: Health-check the user's Obsidian vault — dead links, orphan notes, missing tags/frontmatter — and report before touching anything.
author: Monet
---

# Linting the vault

A REPORT first, repairs only on request. Requires an enabled vault.

1. Map the vault: ObsidianSearch with broad queries and tags to sample its
   structure; ObsidianRead hubs (heavily-backlinked notes).
2. Look for:
   - dead wikilinks (a link whose target ObsidianRead cannot resolve);
   - orphans (notes with no backlinks and no outgoing links);
   - near-duplicates (two names for one concept — suggest a merge);
   - missing or inconsistent frontmatter/tags versus the vault's own style.
3. Report findings grouped by kind, each item a [[wikilink]], with the
   single suggested fix per item.
4. Fix ONLY what the user picks, one ObsidianWrite per fix — never a bulk
   rewrite of notes you were not asked to touch. Removing a note is
   ObsidianWrite mode:trash — it moves to the vault's .trash, recoverable.
`;

const BUILTIN_SKILLS: Record<string, string> = {
  "sandbox-documents": SANDBOX_DOCUMENTS_SKILL,
  "wiki-query": WIKI_QUERY_SKILL,
  "wiki-ingest": WIKI_INGEST_SKILL,
  "wiki-lint": WIKI_LINT_SKILL,
};

export function ensureBuiltinSkills(): void {
  try {
    const base = join(getDataDir(), "claude", "skills");
    for (const [slug, body] of Object.entries(BUILTIN_SKILLS)) {
      const dir = join(base, slug);
      if (existsSync(dir)) continue; // never clobber user edits
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), body, "utf-8");
      console.log(`[skills] installed built-in skill: ${slug}`);
    }
  } catch (err) {
    console.warn(
      "[skills] failed to install built-in skills:",
      err instanceof Error ? err.message : err,
    );
  }
}
