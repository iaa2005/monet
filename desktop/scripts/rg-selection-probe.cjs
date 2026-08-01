/**
 * What one browser element-pick pays for its "likely source files" hint.
 *
 * The hint runs ripGrep up to nine times (three elements × three search
 * terms) before the chip reaches the composer. With no ripgrep on PATH the
 * resolver used to fall through to a manual walk that reads every file in the
 * workspace — in the main process, so the whole app stopped answering. The
 * user's report was "selecting an element takes forever, or does not work".
 *
 * This times the real function against the real workspace.
 */
const { app } = require("electron");
const { join } = require("path");
const { pathToFileURL } = require("url");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
};

app.whenReady().then(async () => {
  const { ripGrep, getWorkspacePath } = await import(
    pathToFileURL(join(__dirname, "..", "out-probe", "rg.mjs")).href
  );
  const ws = getWorkspacePath();
  console.log("workspace:", ws);

  const search = async (pattern) => {
    const t0 = Date.now();
    const r = await ripGrep({
      pattern,
      path: ws,
      output_mode: "files_with_matches",
      head_limit: 5,
      "-i": false,
      respect_ignore: true,
      timeout_ms: 900,
    });
    return { ms: Date.now() - t0, hits: r.lines.filter(Boolean).length };
  };

  const one = await search("getSessionStore");
  check("a candidate search finds files", one.hits > 0, `${one.hits} in ${one.ms}ms`);
  check("and answers in well under a second", one.ms < 900, `${one.ms}ms`);

  // The real shape: nine searches, as one pick fires.
  const t0 = Date.now();
  for (const p of ["SaveButton", "card", "PlanDocCard", "btn-primary", "Item", "data-id", "kimi", "sandbox", "viewer"])
    await search(p);
  const nine = Date.now() - t0;
  check(
    "nine of them still feel instant",
    nine < 3_000,
    `${nine}ms for the whole pick`,
  );

  console.log(failures === 0 ? "\nALL RG-SELECTION CHECKS PASSED" : `\n${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
