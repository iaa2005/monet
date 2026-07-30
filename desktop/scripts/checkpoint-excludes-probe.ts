/**
 * What a checkpoint refuses to snapshot.
 *
 * Measured on a real data dir: 4.7 GB of 5.6 GB of ALL checkpoint storage was one
 * session whose workspace was the user's Downloads folder — a 602 MB LM Studio
 * installer, a 417 MB zip, a 206 MB installer. Downloads has no .gitignore, and
 * the exclude list was written for a project workspace, so none of it matched.
 *
 * The list is a set of gitignore patterns, so the only test that means anything
 * is what git itself does with them. Every case below runs `git check-ignore`
 * against a throwaway repo carrying the real DEFAULT_EXCLUDES.
 */

import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { DEFAULT_EXCLUDES } from "../src/main/agent/checkpoint-excludes";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const repo = mkdtempSync(join(tmpdir(), "monet-excl-"));
execFileSync("git", ["init", "-q", repo]);
mkdirSync(join(repo, ".git", "info"), { recursive: true });
writeFileSync(join(repo, ".git", "info", "exclude"), DEFAULT_EXCLUDES);

/** Does git ignore this path, with the real exclude file in place? */
const ignored = (rel: string): boolean => {
  const full = join(repo, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "x");
  try {
    execFileSync("git", ["-C", repo, "check-ignore", "-q", rel]);
    return true;
  } catch {
    return false;
  }
};

// ── 1. The files that actually caused it ──────────────────────────────
{
  // Names taken from the pack that ate 4.7 GB.
  const real: string[] = [
    "разработка_и_AI/установщики/LM-Studio-0.4.19-2-x64.exe",
    "Telegram Desktop/gmat-win-R2025a.zip",
    "разработка_и_AI/установщики/DevinUserSetup-x64-3.3.18.exe",
    "разработка_и_AI/архивы/imazing_2.12.7/iMazing 2.12.7.exe",
  ];
  for (const p of real) check(`ignored: ${p.slice(-34)}`, ignored(p));
}

// ── 2. The rest of the class ──────────────────────────────────────────
{
  const heavy = [
    "a.msi",
    "a.dmg",
    "a.pkg",
    "a.deb",
    "a.rpm",
    "a.AppImage",
    "a.iso",
    "disk.vmdk",
    "a.7z",
    "a.rar",
    "a.tar",
    "a.tgz",
    "a.gz",
    "a.xz",
    "a.bz2",
    "a.zst",
    "clip.mp4",
    "clip.mov",
    "clip.mkv",
    "clip.avi",
    "clip.webm",
    "sound.wav",
    "sound.flac",
    "art.psd",
    "art.ai",
    "art.sketch",
    "scene.blend",
  ];
  for (const p of heavy) check(`ignored: ${p}`, ignored(p));
  // Nested, not just at the root — the installers were three levels down.
  check("ignored deep in the tree", ignored("x/y/z/setup.exe"));
}

// ── 3. Our own data directory ─────────────────────────────────────────
{
  // A workspace at the repository root would otherwise snapshot the checkpoint
  // store into a checkpoint, which is the growth that has no ceiling.
  check("the app's data dir is ignored", ignored(".monet/sessions/sessions.db"));
  check("and the packaged one", ignored(".monet-prod/checkpoints/abc/HEAD"));
}

// ── 4. What must still be snapshotted ─────────────────────────────────
{
  // This is the half that matters more: a checkpoint exists to undo the agent's
  // edits, so anything it edits has to be in there.
  const kept = [
    "src/main/index.ts",
    "README.md",
    "package.json",
    "notes.txt",
    "config.yaml",
    "styles.css",
    "index.html",
    "script.py",
    "Makefile",
    "docs/report.pdf",
    "assets/logo.svg",
    "assets/icon.png",
    "data/rows.csv",
    "q.sql",
    "run.sh",
    // An .ai file is Illustrator, but a folder called `.agents` is not a match
    // for any pattern and must be kept.
    ".agents/skills/x/SKILL.md",
  ];
  for (const p of kept) check(`kept: ${p}`, !ignored(p));
  // The build dirs the list already covered, still covered.
  check("node_modules is still ignored", ignored("node_modules/pkg/index.js"));
  check("and dist", ignored("dist/app.js"));
  check("and a log", ignored("debug.log"));
  // A file merely CONTAINING a pattern name is not a match.
  check("exe in the middle of a name is kept", !ignored("src/executor.ts"));
  check("zipped-up is kept", !ignored("src/zipper.ts"));
}

// ── 5. The list itself ────────────────────────────────────────────────
{
  const lines = DEFAULT_EXCLUDES.split("\n").filter(Boolean);
  check("no duplicate patterns", new Set(lines).size === lines.length, lines.length);
  check(
    "every line is a pattern or a comment",
    lines.every((l) => !l.startsWith(" ")),
  );
  check("git's own dir is excluded", lines.includes(".git/"));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKPOINT-EXCLUDE CHECKS PASSED");
process.exit(failures ? 1 : 0);
