/**
 * A chat, exported and imported back — does it arrive whole?
 *
 * The bundle is an interchange format with no test until now, which is exactly
 * the kind of thing that loses a field per release and nobody notices until a
 * user's imported chat is missing its desk. This round-trips a chat built by
 * hand (messages with tool I/O, reasoning, checkpoint shas, attachments, plus
 * the state AROUND it: flags, routine tag, desk, goal, context-event log) and
 * compares what comes out.
 *
 * Runs under Electron because everything here — the session DB, the ui-state
 * file, the goal store — resolves through Electron's data dir.
 *
 *   node scripts/build-transfer-probe.mjs && electron scripts/transfer-probe.cjs
 */
const { app } = require("electron");
const { join } = require("path");
const { pathToFileURL } = require("url");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!pass) failures++;
};

app.whenReady().then(async () => {
  const mod = await import(
    pathToFileURL(join(__dirname, "..", "out-probe", "transfer.mjs")).href
  );
  const {
    buildBundle,
    applyBundle,
    getSessionStore,
    setUiState,
    getUiState,
    saveGoal,
    loadGoal,
    recordContextEvent,
    listContextEvents,
    replaceTranscript,
    loadTranscriptWithMeta,
  } = mod;

  const store = getSessionStore();

  // ── A chat with everything on it ────────────────────────────────────
  const src = store.create("Ship the dock", "code");
  store.save({
    id: src.id,
    title: "Ship the dock",
    space: "code",
    createdAt: src.createdAt,
    updatedAt: src.updatedAt,
    messageCount: 2,
    messages: [
      {
        id: "m1",
        role: "user",
        content: "make the panels draggable",
        timestamp: 1,
        attachments: [
          { name: "shot.png", mediaType: "image/png", kind: "image", origin: "selection" },
        ],
      },
      {
        id: "m2",
        role: "assistant",
        content: "done",
        timestamp: 2,
        reasoning: "first I considered the sash geometry",
        checkpointSha: "abc123",
        toolCall: {
          id: "t1",
          name: "Edit",
          input: { file: "a.ts" },
          output: "ok",
          status: "done",
        },
      },
    ],
  });
  store.setPinned(src.id, true);
  store.markRoutineChat(src.id, "routine-7");
  replaceTranscript(
    src.id,
    [
      { role: "user", content: "make the panels draggable" },
      { role: "assistant", content: "done" },
    ],
    [false, false],
  );
  setUiState(src.id, {
    dockLayout: { grid: { root: { type: "leaf", data: { views: ["files"] } } } },
    browserTabs: [{ url: "http://localhost:5173/" }],
    activeTab: 0,
    browserExpanded: true,
  });
  saveGoal(src.id, {
    id: "g1",
    objective: "make the panels draggable",
    status: "paused",
    stopReason: "user",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  recordContextEvent(src.id, "compact", { beforeTokens: 100, afterTokens: 40 });

  // ── The round trip ──────────────────────────────────────────────────
  const bundle = buildBundle(src.id, {
    format: "monet",
    includeArtifacts: false,
    includeContext: false,
  });
  check("a bundle is produced", !!bundle, bundle && `v${bundle.version}`);
  check("at the current version", bundle?.version === 3, bundle?.version);
  check(
    "and it does NOT carry system context unless asked",
    !bundle?.context,
  );

  // The wire form, not the object we just built.
  const wire = JSON.parse(JSON.stringify(bundle));
  const out = applyBundle(wire);
  check("it imports into a new chat", !!out && out.id !== src.id, out?.id);
  if (!out) return finish();

  // ── The conversation ────────────────────────────────────────────────
  check("both messages arrive", out.messages.length === 2, out.messages.length);
  check(
    "message ids are regenerated (they are a global key)",
    out.messages.every((m) => m.id !== "m1" && m.id !== "m2"),
    out.messages.map((m) => m.id).join(", "),
  );
  const assistant = out.messages[1];
  check("tool input and output survive", assistant.toolCall?.output === "ok");
  check(
    "reasoning survives",
    assistant.reasoning === "first I considered the sash geometry",
    assistant.reasoning,
  );
  check("the checkpoint sha survives", assistant.checkpointSha === "abc123", assistant.checkpointSha);
  check(
    "an attachment keeps its origin (it renders on a chip)",
    out.messages[0].attachments?.[0]?.origin === "selection",
  );
  const t = loadTranscriptWithMeta(out.id);
  check("the model transcript comes with it", t.messages.length === 2, t.messages.length);

  // ── The state around the chat ───────────────────────────────────────
  check("pinned survives", out.pinned === true, out.pinned);
  check(
    "the routine tag survives",
    store.routineIdOf(out.id) === "routine-7",
    store.routineIdOf(out.id),
  );
  const ui = getUiState(out.id);
  check("the desk comes back", !!ui?.dockLayout, JSON.stringify(ui?.browserTabs));
  check(
    "including the browser's pages",
    ui?.browserTabs?.[0]?.url === "http://localhost:5173/",
  );
  const goal = loadGoal(out.id);
  check("the goal comes back", goal?.objective === "make the panels draggable", goal?.status);
  const events = listContextEvents(out.id);
  check("the context-event log comes back", events.length === 1, events.length);
  check(
    "with the entry itself intact (undo-compact reads type and payload)",
    events[0]?.type === "compact" && events[0]?.payload?.beforeTokens === 100,
    JSON.stringify(events[0]?.payload),
  );
  check(
    "and the source's log is untouched by the import",
    listContextEvents(src.id).length === 1,
    listContextEvents(src.id).length,
  );

  // ── What a bundle must NOT do ───────────────────────────────────────
  //
  // A Code chat's folder is the user's repository. The bundle names the path
  // so a local re-import can rebind, but it must never carry the contents —
  // and a path that means nothing here must not be bound.
  check(
    "the workspace travels as a path only",
    typeof bundle.session.workspace === "string" || bundle.session.workspace === undefined,
  );
  const foreign = JSON.parse(JSON.stringify(bundle));
  foreign.session.workspace = "/no/such/folder/anywhere";
  const stranger = applyBundle(foreign);
  check(
    "and a folder that does not exist here is not adopted",
    stranger?.workspace !== "/no/such/folder/anywhere",
    stranger?.workspace,
  );
  check(
    "no shadow-git checkpoints ride along",
    !("checkpoints" in bundle),
  );

  // ── Older bundles still import ──────────────────────────────────────
  const v2 = JSON.parse(JSON.stringify(bundle));
  v2.version = 2;
  delete v2.uiState;
  delete v2.goal;
  delete v2.contextEvents;
  delete v2.session.pinned;
  delete v2.session.routineId;
  const old = applyBundle(v2);
  check("a v2 bundle still imports", !!old && old.messages.length === 2);
  check("with no desk to restore", !getUiState(old.id)?.dockLayout);
  check("and nothing pretends to be pinned", !old.pinned);

  // ── Junk is refused, not half-imported ──────────────────────────────
  check("junk is refused", applyBundle({ hello: "world" }) === null);
  check(
    "a bundle without messages is refused",
    applyBundle({ format: "monet-chat", version: 3 }) === null,
  );

  finish();
});

function finish() {
  console.log(
    failures === 0 ? "\nALL TRANSFER CHECKS PASSED" : `\n${failures} FAILED`,
  );
  app.exit(failures === 0 ? 0 : 1);
}
