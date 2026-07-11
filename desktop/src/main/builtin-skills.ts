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
import { getDataDir } from "./data-dir.js";

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

export function ensureBuiltinSkills(): void {
  try {
    const base = join(getDataDir(), "claude", "skills");
    const dir = join(base, "sandbox-documents");
    if (existsSync(dir)) return; // never clobber user edits
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), SANDBOX_DOCUMENTS_SKILL, "utf-8");
    console.log("[skills] installed built-in skill: sandbox-documents");
  } catch (err) {
    console.warn(
      "[skills] failed to install built-in skills:",
      err instanceof Error ? err.message : err,
    );
  }
}
