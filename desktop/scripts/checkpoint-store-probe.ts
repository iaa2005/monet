/**
 * The shadow-repo rules: what a checkpoint refuses to snapshot, how a session id
 * becomes a folder name, and whether git actually packs these stores.
 *
 * Every claim here is about what GIT does with our strings, so every check hands
 * them to real git rather than to a reimplementation of it.
 *
 * Two measurements prompted the file. 4.7 GB of 5.6 GB of all checkpoint storage
 * was one session whose workspace was the user's Downloads folder — a 602 MB
 * installer, a 417 MB zip — because Downloads has no .gitignore and the exclude
 * list was written for a project. And across the 78 remaining stores there were
 * 161 817 loose objects and NOT ONE packed, because git's auto-gc threshold is
 * 6 700 per repository and a per-chat repo never reaches it.
 */

import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  DEFAULT_EXCLUDES,
  needsPackConfig,
  sessionSlug,
  withPackConfig,
} from "../src/main/agent/checkpoint-store";

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
  const real = [
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
    "a.msi", "a.dmg", "a.pkg", "a.deb", "a.rpm", "a.AppImage", "a.iso",
    "disk.vmdk", "a.7z", "a.rar", "a.tar", "a.tgz", "a.gz", "a.xz", "a.bz2",
    "a.zst", "clip.mp4", "clip.mov", "clip.mkv", "clip.avi", "clip.webm",
    "sound.wav", "sound.flac", "art.psd", "art.ai", "art.sketch", "scene.blend",
  ];
  for (const p of heavy) check(`ignored: ${p}`, ignored(p));
  // Nested, not just at the root — the installers were three levels down.
  check("ignored deep in the tree", ignored("x/y/z/setup.exe"));
}

// ── 3. Our own data directory ─────────────────────────────────────────
{
  // A workspace at the repository root would otherwise snapshot the checkpoint
  // store into a checkpoint, which is the growth with no ceiling at all.
  check("the app's data dir is ignored", ignored(".monet/sessions/sessions.db"));
  check("and the packaged one", ignored(".monet-prod/checkpoints/abc/HEAD"));
}

// ── 4. What must still be snapshotted ─────────────────────────────────
{
  // The half that matters more: a checkpoint exists to undo the agent's edits, so
  // everything it edits has to be in there.
  const kept = [
    "src/main/index.ts", "README.md", "package.json", "notes.txt",
    "config.yaml", "styles.css", "index.html", "script.py", "Makefile",
    "docs/report.pdf", "assets/logo.svg", "assets/icon.png", "data/rows.csv",
    "q.sql", "run.sh", ".agents/skills/x/SKILL.md",
  ];
  for (const p of kept) check(`kept: ${p}`, !ignored(p));
  check("node_modules is still ignored", ignored("node_modules/pkg/index.js"));
  check("and dist", ignored("dist/app.js"));
  check("and a log", ignored("debug.log"));
  // A name that merely CONTAINS a pattern is not a match.
  check("exe in the middle of a name is kept", !ignored("src/executor.ts"));
  check("zipper is kept", !ignored("src/zipper.ts"));
}

// ── 5. The list itself ────────────────────────────────────────────────
{
  const lines = DEFAULT_EXCLUDES.split("\n").filter(Boolean);
  check("no duplicate patterns", new Set(lines).size === lines.length, lines.length);
  check("git's own dir is excluded", lines.includes(".git/"));
}

// ── 6. A session id as a folder name ──────────────────────────────────
{
  // One copy, because `sessions:delete` must arrive at the same name to remove a
  // chat's store. Two copies that disagree delete nothing — or somebody else's.
  const uuid = "fb7dfa5d-61d0-4483-b9d0-61015fd03035";
  check("a uuid passes through", sessionSlug(uuid) === uuid);
  check(
    "a separator cannot escape the folder",
    !sessionSlug("../../etc/passwd").includes("/"),
    sessionSlug("../../etc/passwd"),
  );
  check("nor a backslash", !sessionSlug("a\\b").includes("\\"));
  check("an empty id still names something", sessionSlug("") === "session");
  check("punctuation alone does too", sessionSlug("///") === "___", sessionSlug("///"));
}

// ── 7. Does git actually start packing? ───────────────────────────────
{
  const ws = mkdtempSync(join(tmpdir(), "monet-pack-ws-"));
  const gitDir = mkdtempSync(join(tmpdir(), "monet-pack-git-"));
  const g = (...args: string[]): string =>
    execFileSync(
      "git",
      ["--git-dir", gitDir, "--work-tree", ws, "-c", "user.name=P", "-c", "user.email=p@p", ...args],
      { encoding: "utf8" },
    );
  g("init", "-q");

  const cfgPath = join(gitDir, "config");
  const before = readFileSync(cfgPath, "utf8");
  check("a fresh store needs the packing config", needsPackConfig(before));
  writeFileSync(cfgPath, withPackConfig(before));
  check("and does not need it twice", !needsPackConfig(readFileSync(cfgPath, "utf8")));
  // The file we appended to must still parse as git config.
  check(
    "git reads the threshold back",
    g("config", "gc.auto").trim() === "400",
    g("config", "gc.auto").trim(),
  );
  check("and the detach flag", g("config", "gc.autoDetach").trim() === "true");

  // Enough distinct blobs to cross the threshold, then ask git what it did.
  for (let turn = 0; turn < 22; turn++) {
    for (let f = 0; f < 30; f++)
      writeFileSync(join(ws, `f${f}.txt`), `turn ${turn} file ${f}`);
    g("add", "-A");
    g("commit", "-q", "--allow-empty", "-m", `t${turn}`);
  }
  const counts = (): { loose: number; packed: number } => {
    const out = g("count-objects", "-v");
    return {
      loose: Number(/count: (\d+)/.exec(out)?.[1] ?? -1),
      packed: Number(/in-pack: (\d+)/.exec(out)?.[1] ?? -1),
    };
  };
  // autoDetach means the gc may still be running, so wait for it rather than
  // guessing — and let it fail if it never happens.
  const started = Date.now();
  while (counts().packed === 0 && Date.now() - started < 60_000) g("count-objects", "-v");
  const first = counts();
  console.log(`   after 22 commits: ${first.loose} loose, ${first.packed} packed`);
  check("git packed the store by itself", first.packed > 0, JSON.stringify(first));

  // NOT "fewer loose than packed" — that assertion was wrong and the probe caught
  // it. Auto-gc packs on a commit and the commits after it go loose again, so
  // loose objects always sit somewhere under the threshold. The claim worth
  // making is that they stay there instead of growing for ever, so: keep going
  // and see whether the loose count tracks the total.
  for (let turn = 22; turn < 62; turn++) {
    for (let f = 0; f < 30; f++)
      writeFileSync(join(ws, `f${f}.txt`), `turn ${turn} file ${f}`);
    g("add", "-A");
    g("commit", "-q", "--allow-empty", "-m", `t${turn}`);
  }
  const wait = Date.now();
  while (counts().packed <= first.packed && Date.now() - wait < 60_000) g("count-objects", "-v");
  const later = counts();
  console.log(`   after 62 commits: ${later.loose} loose, ${later.packed} packed`);
  check("it keeps packing as the chat goes on", later.packed > first.packed, `${first.packed} then ${later.packed}`);
  // Nearly three times the commits must not mean nearly three times the loose
  // objects — that is the difference between bounded and not.
  check(
    "loose objects stay bounded",
    later.loose < first.loose * 2,
    `${first.loose} at 22 commits, ${later.loose} at 62`,
  );
  check(
    "history is intact",
    g("rev-list", "--count", "HEAD").trim() === "62",
    g("rev-list", "--count", "HEAD").trim(),
  );

  // The control, and the shape of the real measurement: the same 62 commits in a
  // store WITHOUT the config pack nothing at all.
  {
    const ws2 = mkdtempSync(join(tmpdir(), "monet-nopack-ws-"));
    const gd2 = mkdtempSync(join(tmpdir(), "monet-nopack-git-"));
    const h = (...args: string[]): string =>
      execFileSync(
        "git",
        ["--git-dir", gd2, "--work-tree", ws2, "-c", "user.name=P", "-c", "user.email=p@p", ...args],
        { encoding: "utf8" },
      );
    h("init", "-q");
    for (let turn = 0; turn < 62; turn++) {
      for (let f = 0; f < 30; f++)
        writeFileSync(join(ws2, `f${f}.txt`), `turn ${turn} file ${f}`);
      h("add", "-A");
      h("commit", "-q", "--allow-empty", "-m", `t${turn}`);
    }
    const out = h("count-objects", "-v");
    const packed = Number(/in-pack: (\d+)/.exec(out)?.[1] ?? -1);
    const loose = Number(/count: (\d+)/.exec(out)?.[1] ?? -1);
    console.log(`   without the config: ${loose} loose, ${packed} packed`);
    check("without the config git packs nothing", packed === 0, `${loose} loose, ${packed} packed`);
    check("which is how 161 817 loose objects happened", loose > later.loose, `${loose} vs ${later.loose}`);
  }
}

// ── 8. A copied store still answers for its shas ──────────────────────
//
// Fork copies the shadow directory so Rewind works in the branch: the copied
// messages carry checkpointShas minted in the ORIGINAL chat's store, and the
// fork's own store starts empty. The claim that makes a plain `cpSync` a
// correct implementation is that nothing in the store is tied to its path —
// objects are content-addressed, and our git() passes --git-dir/--work-tree
// explicitly on every call. This section holds exactly the two commands
// rewindWorkspace runs (`cat-file -e`, `reset --hard`) against a copy.
{
  const { cpSync } = await import("fs");
  const ws = mkdtempSync(join(tmpdir(), "monet-fork-ws-"));
  const storeA = mkdtempSync(join(tmpdir(), "monet-fork-a-"));
  const g = (gitDir: string, ...args: string[]): string =>
    execFileSync(
      "git",
      ["--git-dir", gitDir, "--work-tree", ws, "-c", "user.name=P", "-c", "user.email=p@p", ...args],
      { encoding: "utf8" },
    );

  g(storeA, "init", "-q");
  writeFileSync(join(ws, "app.ts"), "turn one");
  g(storeA, "add", "-A");
  g(storeA, "commit", "-q", "--allow-empty", "-m", "t1");
  const sha = g(storeA, "rev-parse", "HEAD").trim();
  writeFileSync(join(ws, "app.ts"), "turn two");
  g(storeA, "add", "-A");
  g(storeA, "commit", "-q", "--allow-empty", "-m", "t2");

  // The fork: a directory copy, exactly what forkTranscriptToSession does.
  const storeB = join(mkdtempSync(join(tmpdir(), "monet-fork-b-")), "copy");
  cpSync(storeA, storeB, { recursive: true });

  let resolves = true;
  try {
    g(storeB, "cat-file", "-e", `${sha}^{commit}`);
  } catch {
    resolves = false;
  }
  check("the copy resolves the original chat's sha", resolves);

  writeFileSync(join(ws, "app.ts"), "later work");
  g(storeB, "reset", "--hard", sha, "-q");
  check(
    "and rewinds the workspace through it",
    readFileSync(join(ws, "app.ts"), "utf8") === "turn one",
    readFileSync(join(ws, "app.ts"), "utf8"),
  );

  // The control — the bug this fix removes: WITHOUT the copy, a fresh store
  // knows nothing of the sha, which is what every Rewind in a fork ran into.
  const storeC = mkdtempSync(join(tmpdir(), "monet-fork-c-"));
  g(storeC, "init", "-q");
  let fresh = true;
  try {
    g(storeC, "cat-file", "-e", `${sha}^{commit}`);
  } catch {
    fresh = false;
  }
  check("without the copy the sha is unknown — the fork bug", !fresh);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKPOINT-STORE CHECKS PASSED");
process.exit(failures ? 1 : 0);
