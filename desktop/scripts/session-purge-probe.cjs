/**
 * Does deleting a chat actually forget it?
 *
 * It did not. A delete removed the session row, its messages (foreign-key
 * cascade) and its plans, and left the transcript and the context-event log
 * in the database forever — 8545 rows and 108 events from 463 chats that no
 * longer existed on a real install, 11.8 MB of a 44 MB file. Nothing noticed
 * because nothing looked: every store cleaned itself at the call site, and
 * two of them were simply never called.
 *
 * So this builds a chat with something in EVERY store, deletes it, and asks
 * each store whether it still remembers. Plus the startup sweep: it must
 * remove what an older version left behind and leave live chats alone.
 *
 * Runs under Electron because the session DB is better-sqlite3 (Electron ABI)
 * and the data dir resolves through Electron's app paths.
 */
const { app } = require("electron");
const { join } = require("path");
const { pathToFileURL } = require("url");
const { existsSync, mkdirSync, writeFileSync } = require("fs");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!pass) failures++;
};

app.whenReady().then(async () => {
  const mod = await import(
    pathToFileURL(join(__dirname, "..", "out-probe", "purge.mjs")).href
  );
  const {
    getSessionStore,
    replaceTranscript,
    loadTranscriptWithMeta,
    recordContextEvent,
    listContextEvents,
    setUiState,
    getUiState,
    saveGoal,
    loadGoal,
    purgeSessionData,
    sweepOrphans,
    getDataSubdir,
    planStore,
  } = mod;

  const store = getSessionStore();

  // ── A chat with something in every store ────────────────────────────
  const sess = store.create("Doomed chat", "code");
  const id = sess.id;
  store.save({
    id,
    title: "Doomed chat",
    space: "code",
    createdAt: sess.createdAt,
    updatedAt: sess.updatedAt,
    messageCount: 1,
    messages: [{ id: "m1", role: "user", content: "hello", timestamp: 1 }],
  });
  replaceTranscript(id, [{ role: "user", content: "hello" }], [false]);
  recordContextEvent(id, "compact", { beforeTokens: 10, afterTokens: 5 });
  setUiState(id, { dockLayout: { grid: {} }, browserTabs: [{ url: "http://x/" }] });
  saveGoal(id, {
    id: "g1",
    objective: "finish",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  planStore.createPlan(id, { title: "P", body: "b", todos: ["one"] });
  // The three directories a chat owns on disk.
  const dirs = ["artifacts", "sandboxes", "checkpoints"].map((root) => {
    const d = join(getDataSubdir(root), id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "leftover.txt"), "x", "utf-8");
    return d;
  });

  check("the chat has a transcript", loadTranscriptWithMeta(id).messages.length === 1);
  check("a context event", listContextEvents(id).length === 1);
  check("a desk", !!getUiState(id));
  check("a goal", !!loadGoal(id));
  check("a plan", !!planStore.currentPlan(id));
  check("and its folders", dirs.every((d) => existsSync(d)));

  // ── Delete it ───────────────────────────────────────────────────────
  purgeSessionData(id);
  store.delete(id);

  check("the session row is gone", !store.get(id));
  check(
    "the transcript is gone",
    loadTranscriptWithMeta(id).messages.length === 0,
    loadTranscriptWithMeta(id).messages.length,
  );
  check("the context-event log is gone", listContextEvents(id).length === 0);
  check("the desk is gone", !getUiState(id));
  check("the goal is gone", !loadGoal(id));
  check("the plan is gone", !planStore.currentPlan(id));
  check(
    "and every folder with it",
    dirs.every((d) => !existsSync(d)),
    dirs.filter((d) => existsSync(d)).join(", "),
  );

  // ── The sweep: old leftovers go, live chats stay ────────────────────
  const ghost = "ghost-chat-" + Date.now();
  replaceTranscript(ghost, [{ role: "user", content: "from a deleted chat" }], [false]);
  recordContextEvent(ghost, "compact", { beforeTokens: 1, afterTokens: 1 });

  const live = store.create("Live chat", "code");
  replaceTranscript(live.id, [{ role: "user", content: "still here" }], [false]);
  recordContextEvent(live.id, "compact", { beforeTokens: 2, afterTokens: 1 });

  const swept = sweepOrphans();
  check("the sweep reports what it removed", swept.transcript >= 1, JSON.stringify(swept));
  check(
    "an orphaned transcript is gone",
    loadTranscriptWithMeta(ghost).messages.length === 0,
  );
  check("its events too", listContextEvents(ghost).length === 0);
  check(
    "the live chat keeps its transcript",
    loadTranscriptWithMeta(live.id).messages.length === 1,
  );
  check("and its events", listContextEvents(live.id).length === 1);

  // ── Why a chat stopped outlives the app that was running it ────────
  //
  // The sidebar marks a chat that died mid-turn, and the case that matters is
  // the one nobody saw: it failed while the user was elsewhere, and the app
  // was closed afterwards. So the reason lives in the DATABASE, and a fresh
  // read has to find it — a renderer-memory flag would be gone by then.
  const failed = store.create("Failed chat", "code");
  check("a new chat carries no error", !store.get(failed.id)?.lastError);

  store.setLastError(failed.id, "API 500: upstream said no");
  check(
    "an error is remembered by the row",
    store.get(failed.id)?.lastError === "API 500: upstream said no",
    store.get(failed.id)?.lastError,
  );
  check(
    "and by the list the sidebar reads",
    store.list(50, 0, "code").find((r) => r.id === failed.id)?.lastError ===
      "API 500: upstream said no",
  );
  check(
    "the chat is not reordered by having failed",
    store.get(failed.id)?.updatedAt === failed.updatedAt,
    store.get(failed.id)?.updatedAt,
  );

  store.setLastError(failed.id, null);
  check(
    "continuing the chat clears it",
    !store.get(failed.id)?.lastError,
    store.get(failed.id)?.lastError,
  );
  store.delete(failed.id);

  purgeSessionData(live.id);
  store.delete(live.id);

  console.log(
    failures === 0 ? "\nALL PURGE CHECKS PASSED" : `\n${failures} FAILED`,
  );
  app.exit(failures === 0 ? 0 : 1);
});
