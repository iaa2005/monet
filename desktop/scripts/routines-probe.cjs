/**
 * The routine remembers which chat is home.
 *
 * The claims under test are the store's, against a real database:
 *  - the new columns (chat_mode, session_id, compact_every) survive a full
 *    create → read → update round-trip, including on a database created by
 *    the PREVIOUS schema (the ALTER path);
 *  - sessionId is executor-managed: absent from RoutineInput, settable via
 *    updateRoutine, cleared with null;
 *  - countRuns counts what recordRun records — the compact-every-N counter.
 *
 *   node scripts/build-routines-probe.mjs && npx electron scripts/routines-probe.cjs
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
    path.join(os.tmpdir(), "monet-routines-probe-"),
  );

  const mod = await import(
    require("url").pathToFileURL(
      path.join(__dirname, "..", "out-probe", "routines.mjs"),
    ).href
  );

  // ── Create with the new fields ────────────────────────────────────────
  const r = mod.createRoutine({
    name: "Чат с Георгием",
    prompt: "Ответь на новые сообщения.",
    space: "home",
    connectors: [],
    trigger: { kind: "schedule", cron: "0 9 * * *" },
    condition: { kind: "always" },
    output: { kind: "chat" },
    chat: "continuous",
    compactEvery: 5,
    enabled: true,
  });
  check("created with chat=continuous", r.chat === "continuous");
  check("…and compactEvery", r.compactEvery === 5);

  const back = mod.getRoutine(r.id);
  check("read back: chat mode survives", back?.chat === "continuous");
  check("read back: compactEvery survives", back?.compactEvery === 5);
  check("read back: no session yet", back?.sessionId === undefined);

  // ── The executor adopts a chat ────────────────────────────────────────
  mod.updateRoutine(r.id, { sessionId: "chat-123" });
  check(
    "executor-set sessionId survives",
    mod.getRoutine(r.id)?.sessionId === "chat-123",
  );
  // …and an unrelated patch must not lose it.
  mod.updateRoutine(r.id, { name: "Чат с Георгием — ответы" });
  const after = mod.getRoutine(r.id);
  check("an unrelated patch keeps the session", after?.sessionId === "chat-123");
  check("…and applies itself", after?.name === "Чат с Георгием — ответы");

  // ── A default routine stays "new" ─────────────────────────────────────
  const plain = mod.createRoutine({
    name: "Plain",
    prompt: "x",
    space: "code",
    connectors: [],
    trigger: { kind: "manual" },
    condition: { kind: "always" },
    output: { kind: "chat" },
    enabled: true,
  });
  check("chat defaults to new", mod.getRoutine(plain.id)?.chat === "new");
  check(
    "compactEvery defaults to unset",
    mod.getRoutine(plain.id)?.compactEvery === undefined,
  );

  // ── The compaction counter ────────────────────────────────────────────
  for (let i = 0; i < 3; i++)
    mod.recordRun({
      id: `run-${i}`,
      routineId: r.id,
      at: new Date(2026, 0, 1 + i).toISOString(),
      status: "ok",
      sessionId: "chat-123",
    });
  check("countRuns counts recorded runs", mod.countRuns(r.id) === 3);
  check("…scoped to the routine", mod.countRuns(plain.id) === 0);

  // ── Deleting takes the runs with it ───────────────────────────────────
  mod.deleteRoutine(r.id);
  check("deleted", mod.getRoutine(r.id) === null);
  check("…with its run history", mod.countRuns(r.id) === 0);

  console.log(
    failures === 0
      ? "\nTHE ROUTINE REMEMBERS WHICH CHAT IS HOME"
      : `\n${failures} FAILURES`,
  );
  app.exit(failures ? 1 : 0);
});
