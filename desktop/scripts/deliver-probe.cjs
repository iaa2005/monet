/**
 * DeliverFiles hands a file to the user; nothing else does.
 *
 * The claims under test are the tool's, against the real modules:
 *  - a sandbox-relative path (subfolders, backslashes, "./" tolerated) is
 *    resolved inside the chat's work dir and SNAPSHOTTED into the artifacts
 *    store — a later overwrite of the sandbox copy must not touch what was
 *    delivered;
 *  - the output carries an `[artifact]` line per delivered file (the marker
 *    the chat renders as a card) and no `[file]` lines;
 *  - a missing file, a directory, and an escaping path are refused by name,
 *    and refusing them all is an error while a partial delivery is not.
 *
 *   node scripts/build-deliver-probe.mjs && npx electron scripts/deliver-probe.cjs
 */

const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

app.whenReady().then(async () => {
  let failures = 0;
  const check = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  process.env.MONET_PROBE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "monet-deliver-probe-"),
  );

  const mod = await import(
    require("url").pathToFileURL(
      path.join(__dirname, "..", "out-probe", "deliver.mjs"),
    ).href
  );

  const SID = "probe-deliver";
  const work = mod.sandboxWorkDir(SID);
  fs.mkdirSync(path.join(work, "charts"), { recursive: true });
  fs.writeFileSync(path.join(work, "report.pdf"), "PDF-BYTES-V1");
  fs.writeFileSync(path.join(work, "charts", "q4.png"), "PNG-BYTES");

  const ctx = { sessionId: SID };
  const call = (files) => mod.DeliverFilesTool.call({ files }, ctx);

  // ── Delivering two finished files, one of them by a sloppy path ──────
  const r1 = await call(["./report.pdf", "charts\\q4.png"]);
  const t1 = r1.data.text;
  check("delivery succeeds", !r1.data.isError, t1);
  check(
    "an [artifact] line per file",
    (t1.match(/^\[artifact\] /gm) || []).length === 2,
    t1.split("\n")[0],
  );
  check("…and no [file] lines", !/^\[file\] /m.test(t1));
  check(
    "the pdf line carries its mime and sandbox name",
    /\[artifact\] application\/pdf report\.pdf :: artifacts\//.test(t1),
  );
  check(
    "the subfolder file keeps its relative name",
    /\[artifact\] image\/png charts\/q4\.png :: artifacts\//.test(t1),
  );

  // ── The delivered copy is a snapshot ─────────────────────────────────
  const artDir = mod.artifactSessionDir(SID);
  const deliveredPdf = fs
    .readdirSync(artDir)
    .filter((f) => f.endsWith("-report.pdf"))
    .map((f) => path.join(artDir, f))[0];
  check("the delivered copy exists in the artifacts store", !!deliveredPdf);
  fs.writeFileSync(path.join(work, "report.pdf"), "PDF-BYTES-V2-REWRITTEN");
  check(
    "…and a later sandbox overwrite does not touch it",
    fs.readFileSync(deliveredPdf, "utf-8") === "PDF-BYTES-V1",
  );

  // ── Refusals, by name ────────────────────────────────────────────────
  const r2 = await call(["missing.csv", "charts", "../outside.txt"]);
  const t2 = r2.data.text;
  check("delivering nothing is an error", r2.data.isError === true);
  check("a missing file is named", /missing\.csv: no such file/.test(t2));
  check("a directory is refused", /charts: is a directory/.test(t2));
  check("an escaping path is refused", /outside\.txt: invalid path/.test(t2));
  check("no [artifact] line sneaks out of a refusal", !/\[artifact\]/.test(t2));

  // ── A partial delivery is a delivery ─────────────────────────────────
  const r3 = await call(["report.pdf", "missing.csv"]);
  check("one good file among bad ones is not an error", !r3.data.isError);
  check(
    "…and the summary names both outcomes",
    /Delivered to the user: report\.pdf/.test(r3.data.text) &&
      /Not delivered:/.test(r3.data.text),
  );

  console.log(
    failures === 0
      ? "\nDELIVERY IS AN ACT, AND ONLY THE ACT DELIVERS"
      : `\n${failures} FAILURES`,
  );
  app.exit(failures ? 1 : 0);
});
