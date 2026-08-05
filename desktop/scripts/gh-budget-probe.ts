/**
 * Getting a repository's file list when GitHub says no.
 *
 * Reported, with feeling: "GitHub rate limit reached — it resets in 19 minutes.
 * ну это издевательство! и что? я должен ждать столько?" Anonymous
 * api.github.com allows 60 calls an hour and one listing costs one of them.
 *
 * This talks to the network deliberately. The claim under test is not that my tar
 * parser handles my own fixture — it is that codeload answers when the API will
 * not, and that what comes back is the SAME file list. A fallback returning a
 * subtly different tree would resolve skills to different folders, which is worse
 * than an error.
 */

import { gzipSync } from "fflate";
import { tarPaths, treeViaArchive } from "../src/main/directory/github-budget.js";

/** A tar block, same constant the parser uses. */
const BLOCK = 512;

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const budget = async (): Promise<number> => {
  const r = (await (await fetch("https://api.github.com/rate_limit")).json()) as {
    resources: { core: { remaining: number; limit: number } };
  };
  return r.resources.core.remaining;
};

const remaining = await budget();
console.log(`\ngithub api budget: ${remaining} remaining\n`);

// ── 1. The archive answers, and costs nothing ─────────────────────────
{
  const repo = "vercel-labs/agent-skills";
  const before = remaining;
  const paths = await treeViaArchive(repo);
  const after = await budget();
  check("the archive returns files", paths.length > 10, paths.length);
  // The whole point. One request is allowed for the budget check itself.
  check("and spends no API budget", after >= before - 1, `${before} then ${after}`);
  check(
    "the archive's own top folder is stripped",
    paths.every((p) => !/^agent-skills-/.test(p)),
    paths[0],
  );
  const dirs = paths
    .filter((p) => p.endsWith("/SKILL.md"))
    .map((p) => p.slice(0, -"/SKILL.md".length))
    .sort();
  console.log("   skills found:", dirs.length, "—", dirs.slice(0, 3).join(", "));
  check("it finds the nine skills", dirs.length === 9, dirs.length);
  check(
    "including the reported one, at the path the API reports",
    dirs.includes("skills/react-best-practices"),
    dirs.join(","),
  );
}

// ── 2. Identical to what the API would have said ──────────────────────
if (remaining > 2) {
  const repo = "anthropics/skills";
  const api = (await (
    await fetch(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, {
      headers: { "User-Agent": "monet-desktop" },
    })
  ).json()) as { tree?: { path: string; type: string }[] };
  const fromApi = (api.tree ?? [])
    .filter((e) => e.type === "blob")
    .map((e) => e.path)
    .sort();
  const fromTar = (await treeViaArchive(repo)).sort();
  check(
    "the two lists are the same length",
    fromApi.length === fromTar.length,
    `api ${fromApi.length} vs tar ${fromTar.length}`,
  );
  const missing = fromApi.filter((p) => !fromTar.includes(p));
  const extra = fromTar.filter((p) => !fromApi.includes(p));
  check("nothing the API lists is missing", missing.length === 0, missing.slice(0, 5).join(","));
  check("and nothing extra is invented", extra.length === 0, extra.slice(0, 5).join(","));
  // The claim that decides installs: the same skill folders, exactly.
  const skills = (l: string[]): string =>
    l.filter((p) => p.endsWith("/SKILL.md")).sort().join("|");
  check("the skill folders are identical", skills(fromApi) === skills(fromTar));
} else {
  console.log("SKIP  the API comparison — no budget left, which is the case this fixes");
}

// ── 3. Long paths, which tar cannot store in one field ────────────────
//
// Measured first: NO real repository tried has a path over 100 bytes —
// microsoft/azure-skills tops out at 82, wshobson/agents at 88 across 1 159
// files, pbakaus/impeccable at 83 across 2 942. So real data cannot test this,
// and the honest test is a tar built here.
//
// It matters because both escapes produce a TRUNCATED path if ignored, and a
// truncated path does not fail — it resolves a skill to the wrong folder.
{
  const enc = new TextEncoder();
  /** One 512-byte tar header. */
  const header = (name: string, size: number, type: string, prefix = ""): Uint8Array => {
    const h = new Uint8Array(BLOCK);
    h.set(enc.encode(name.slice(0, 100)), 0);
    h.set(enc.encode("0000644\0"), 100);
    h.set(enc.encode(size.toString(8).padStart(11, "0") + "\0"), 124);
    h.set(enc.encode("00000000000\0"), 136);
    h[156] = type.charCodeAt(0);
    h.set(enc.encode("ustar\0" + "00"), 257);
    if (prefix) h.set(enc.encode(prefix.slice(0, 155)), 345);
    // Checksum: spaces while computing, then the octal sum. The parser does not
    // verify it, but a real tar tool would, and a fixture that only this parser
    // can read proves less.
    h.fill(32, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    return h;
  };
  const pad = (b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(Math.ceil(b.length / BLOCK) * BLOCK);
    out.set(b);
    return out;
  };
  const join = (...parts: Uint8Array[]): Uint8Array => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  const root = "repo-abc123";
  // 1. An ordinary short file.
  const short = `${root}/SKILL.md`;
  // 2. ustar: the path split across `prefix` and `name`.
  const deepDir = `${root}/references/routes/deeply/nested/further/still/going/${"x".repeat(40)}`;
  const deepFile = "a-file-with-a-fairly-long-name-of-its-own.md";
  // 3. GNU: the whole path as the body of an 'L' entry.
  const gnuName = `${root}/${"long-segment/".repeat(9)}end.md`;

  const archive = join(
    header(short, 5, "0"),
    pad(enc.encode("hello")),
    header(deepFile, 3, "0", deepDir),
    pad(enc.encode("abc")),
    header("././@LongLink", gnuName.length + 1, "L"),
    pad(enc.encode(gnuName + "\0")),
    header(gnuName.slice(0, 100), 3, "0"),
    pad(enc.encode("xyz")),
    header(`${root}/adir`, 0, "5"),
    new Uint8Array(BLOCK * 2),
  );
  const paths = tarPaths(gzipSync(archive));

  check("the short file is there", paths.includes("SKILL.md"), paths.join(" | "));
  check(
    "a ustar prefix+name path is rejoined, not truncated",
    paths.includes(`${deepDir.slice(root.length + 1)}/${deepFile}`),
    paths.join(" | "),
  );
  check(
    "a GNU LongLink path comes through whole",
    paths.includes(gnuName.slice(root.length + 1)),
    paths.find((p) => p.endsWith("end.md")),
  );
  check(
    "and the long path really is over 100 bytes",
    gnuName.length > 100 && `${deepDir}/${deepFile}`.length > 100,
    `${gnuName.length}, ${`${deepDir}/${deepFile}`.length}`,
  );
  const junk = paths.filter((p) => p.includes("@LongLink") || p.includes("PaxHeader"));
  check("no tar metadata leaks in as a file", junk.length === 0, junk.join(","));
  check("a directory entry is not a file", !paths.includes("adir"), paths.join(" | "));
  check("exactly three files", paths.length === 3, paths.length);
}

// ── 3b. And the same parser on a real repository ───────────────────────
{
  const paths = await treeViaArchive("microsoft/azure-skills");
  const junk = paths.filter((p) => p.includes("@LongLink") || p.includes("PaxHeader"));
  check("no metadata in a real archive either", junk.length === 0, junk.slice(0, 3).join(","));
  check(
    "a known deep path is present",
    paths.some((p) => p.startsWith(".github/plugins/azure-skills/skills/azure-compute/")),
  );
}

// ── 4. Junk in, error out ─────────────────────────────────────────────
{
  let threw = false;
  try {
    tarPaths(new Uint8Array([1, 2, 3, 4]));
  } catch {
    threw = true;
  }
  check("junk input fails rather than returning nonsense", threw);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL GITHUB-BUDGET CHECKS PASSED");
process.exit(failures ? 1 : 0);
