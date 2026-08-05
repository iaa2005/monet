/**
 * The Files panel's search, and the watcher's quiet.
 *
 * Both are about what does NOT show up. The search box sat wired to nothing for
 * as long as it existed, so "it returns results" is not the bar — the bar is
 * that it returns the file you meant rather than eight copies of it out of
 * node_modules, and that it says so when it gave up early.
 *
 * Run against a real directory tree in a temp folder: the whole point of the
 * search is that it walks folders the lazy tree has never loaded, and a fake
 * readdir would test the one thing that was never in doubt.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { searchFiles, skipDir } from "../src/main/workspace/search.js";
import { isNoise } from "../src/main/workspace/watch.js";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

const root = mkdtempSync(join(tmpdir(), "monet-search-"));
const put = (rel: string, body = "x"): void => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
};

put("src/App.tsx");
put("src/components/AppHeader.tsx");
put("src/components/deep/one/two/AppFooter.tsx");
put("node_modules/react/App.tsx");
put("node_modules/react-dom/AppShell.tsx");
put(".git/AppConfig");
put("dist/App.tsx");
put("readme.md");
mkdirSync(join(root, "apps"), { recursive: true });

try {
  // ── 1. It finds what the lazy tree never loaded ─────────────────────
  {
    const { hits } = await searchFiles(root, "app");
    const rels = hits.map((h) => h.rel);
    check(
      "a file four folders down is found",
      rels.includes("src/components/deep/one/two/AppFooter.tsx"),
      rels.join(" "),
    );
    check("a top-level match is found", rels.includes("src/App.tsx"));
  }

  // ── 2. …without the noise that made searching pointless ─────────────
  {
    const { hits } = await searchFiles(root, "app");
    const rels = hits.map((h) => h.rel);
    check(
      "nothing from node_modules",
      !rels.some((r) => r.startsWith("node_modules/")),
      rels.filter((r) => r.startsWith("node_modules/")).join(" "),
    );
    check(
      "nothing from .git or dist",
      !rels.some((r) => r.startsWith(".git/") || r.startsWith("dist/")),
    );
    check("skipDir covers both kinds", skipDir(".git") && skipDir("node_modules"));
    check("an ordinary folder is walked", !skipDir("src"));
  }

  // ── 3. Shallow before deep ──────────────────────────────────────────
  {
    const { hits } = await searchFiles(root, "app");
    const rels = hits.map((h) => h.rel);
    const shallow = rels.indexOf("src/App.tsx");
    const deep = rels.indexOf("src/components/deep/one/two/AppFooter.tsx");
    check(
      "the shallower path is listed first",
      shallow !== -1 && deep !== -1 && shallow < deep,
      `${shallow} < ${deep}`,
    );
  }

  // ── 4. Matching, and the honesty of a cut-short list ────────────────
  {
    const { hits } = await searchFiles(root, "APP");
    check("case does not matter", hits.length > 0, hits.length);

    const dirs = (await searchFiles(root, "apps")).hits;
    check(
      "a folder can be a hit too",
      dirs.some((h) => h.name === "apps" && h.isDirectory),
    );

    const cut = await searchFiles(root, "app", { limit: 2 });
    check("a limit is honoured", cut.hits.length === 2, cut.hits.length);
    check("…and reported rather than hidden", cut.truncated);

    const full = await searchFiles(root, "app");
    check("a complete list is not marked truncated", !full.truncated);

    const none = await searchFiles(root, "   ");
    check(
      "a blank query finds nothing, rather than everything",
      none.hits.length === 0,
    );
  }

  // ── 5. The watcher stays quiet during a build ───────────────────────
  {
    check("a build directory is ignored", isNoise("dist/index.js"));
    check("a nested node_modules is ignored", isNoise("src/node_modules/x/y.js"));
    check("git's own churn is ignored", isNoise(".git/index.lock"));
    check("an editor swap file is ignored", isNoise("src/.App.tsx.swp"));
    check("a real edit is reported", !isNoise("src/App.tsx"));
    check("a new top-level file is reported", !isNoise("notes.md"));
    check("an empty path is not a change", isNoise(""));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\nALL FILE-SEARCH CHECKS PASSED"
    : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
