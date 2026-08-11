/**
 * A skill's bundled files reach the sandbox — at the SAME relative paths its
 * instructions reference, subfolders and all.
 *
 * A skill's "Base directory" is a HOST path; a sandboxed chat cannot read it.
 * So a skill whose SKILL.md says "read references/foo.md" or "run
 * scripts/bar.py" sends the model hunting unless the files were copied in
 * first. That copy used to live ONLY in the Skill tool's call() — the
 * slash-command path expanded the same instructions with none of the files,
 * and the model burned turns discovering they were absent (measured: five on
 * the equity-research skill).
 *
 * bridgeSkillFilesToSandbox is the one copy both paths now share. This drives
 * it against a real skill dir and a real sandbox work dir and checks what
 * SandboxRead would then see.
 *
 *   npm run smoke:skillbridge
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
    );
  }
}

const { setDataDir } = await import("../src/main/data-dir.js");
setDataDir(mkdtempSync(join(tmpdir(), "skill-bridge-probe-")));

const { bridgeSkillFilesToSandbox } = await import(
  "../src/main/agent/skill-tool.js"
);
const { readSandboxFile, listSandboxFiles } = await import(
  "../src/main/sandbox/files.js"
);

// ─── A skill on the host, with the nested shape a real one has ──────────
const skillDir = mkdtempSync(join(tmpdir(), "skill-src-"));
writeFileSync(join(skillDir, "SKILL.md"), "# the skill\nread references/data.md");
mkdirSync(join(skillDir, "references"), { recursive: true });
writeFileSync(join(skillDir, "references", "data.md"), "SOURCES: yahoo, ifind");
mkdirSync(join(skillDir, "scripts"), { recursive: true });
writeFileSync(join(skillDir, "scripts", "chart.py"), "print('chart')");
writeFileSync(join(skillDir, "empty.txt"), ""); // zero-byte: must be skipped

const SID = "bridge-sess";
const note = bridgeSkillFilesToSandbox(SID, skillDir);

// ─── What the model would now see ───────────────────────────────────────
{
  const names = listSandboxFiles(SID).map((f) => f.name);
  check(
    "the nested reference file is in the sandbox at its relative path",
    names.includes("references/data.md"),
    names,
  );
  check(
    "…and the script, subfolder preserved",
    names.includes("scripts/chart.py"),
    names,
  );
  check(
    "SKILL.md is NOT copied — it is already inlined in the prompt",
    !names.includes("SKILL.md"),
    names,
  );
  check(
    "a zero-byte file is skipped, not copied",
    !names.includes("empty.txt"),
    names,
  );
}

// ─── SandboxRead sees the real bytes at the referenced path ─────────────
{
  const r = readSandboxFile(SID, "references/data.md");
  check(
    "SandboxRead returns the bridged file's contents",
    r.ok && r.content === "SOURCES: yahoo, ifind",
    r,
  );
}

// ─── The note tells the model they are there, and not to hunt on disk ───
{
  check("the note names the files that landed", note.includes("references/data.md"), note);
  check(
    "…and says the host Base directory is unreachable",
    /not\s+reachable/i.test(note),
    note,
  );
}

// ─── Nothing to copy → empty note, not a crash ──────────────────────────
{
  const emptyDir = mkdtempSync(join(tmpdir(), "skill-empty-"));
  writeFileSync(join(emptyDir, "SKILL.md"), "# only the inlined file");
  const n = bridgeSkillFilesToSandbox("other-sess", emptyDir);
  check("a skill with only SKILL.md bridges nothing and says nothing", n === "", n);
}

console.log(
  failures ? `\n${failures} FAILED` : "\nSKILL FILES REACH THE SANDBOX",
);
process.exit(failures ? 1 : 0);
