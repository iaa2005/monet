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
  // A COMPACTED chat, written the way the agent writes one.
  //
  // Four model messages for two bubbles: the first exchange has been folded —
  // it is still there, out of context — and a summary stands in front of it as
  // a hidden turn (a user-role message the chat draws no prompt for). That is
  // what a compaction leaves behind now, and it is the shape a bundle has to
  // carry: the ids that tie turns to bubbles, and which turns the model may
  // still read.
  replaceTranscript(
    src.id,
    [
      { role: "user", content: "make the panels draggable" },
      { role: "assistant", content: "done" },
      { role: "user", content: "[summary of the earlier conversation]" },
      { role: "user", content: "and now the dock" },
    ],
    [false, false, true, false],
    {
      ids: ["m1", "t-assistant", "t-summary", "m2"],
      inContext: [false, false, true, true],
    },
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
  // And the log entry that makes it undoable: the summary it left, and the
  // turns that summary stands for — by id, which is the whole of an undo now.
  recordContextEvent(src.id, "compact", {
    beforeTokens: 100,
    afterTokens: 40,
    headerId: "t-summary",
    foldedIds: ["m1", "t-assistant"],
  });

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
  // ── The transcript, all four columns of it ──────────────────────────
  //
  // It used to travel as messages + hidden. The other two — the id each turn
  // is known by, and whether the model may still read it — were written into
  // the bundle by accident and dropped on the way in, so an imported chat
  // arrived with no prompt it could name and with EVERYTHING back in context.
  // Since a compaction folds rather than deletes, that meant the summary and
  // every turn it stands for both went to the model.
  const t = loadTranscriptWithMeta(out.id);
  check("the model transcript comes with it", t.messages.length === 4, t.messages.length);
  check(
    "including the turns a summary folded — nothing was deleted",
    t.messages.some((m) => m.content === "make the panels draggable"),
    t.messages.map((m) => String(m.content).slice(0, 24)),
  );
  check(
    "WHAT THE MODEL MAY READ SURVIVES THE TRIP",
    JSON.stringify(t.inContext) === JSON.stringify([false, false, true, true]),
    t.inContext,
  );
  check(
    "…and so does which turns have no prompt bubble",
    JSON.stringify(t.hidden) === JSON.stringify([false, false, true, false]),
    t.hidden,
  );
  // The bubbles were re-minted (a message id is a global key), so a transcript
  // id that NAMED one has to be re-minted with it or the thread is cut.
  const newFirst = out.messages[0].id;
  const newSecond = out.messages[1].id;
  check(
    "a turn still answers to the bubble it belongs to",
    t.ids[0] === newFirst,
    { transcript: t.ids[0], bubble: newFirst },
  );
  check(
    "…including one the import re-minted further down",
    t.ids[3] === newSecond,
    { transcript: t.ids[3], bubble: newSecond },
  );
  check(
    "a turn with no bubble keeps the id the agent gave it",
    t.ids[2] === "t-summary",
    t.ids[2],
  );

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
  // UNDO STILL HAS SOMETHING TO POINT AT.
  //
  // The event names the summary and the turns it stands for by id. Imported
  // without translating those into this install's ids, "Undo" looks them up,
  // finds nothing, and does nothing — silently, which is the worst way for a
  // button to fail.
  check(
    "the compaction still names the turns it folded, in THIS chat's ids",
    JSON.stringify(events[0]?.payload?.foldedIds) ===
      JSON.stringify([newFirst, "t-assistant"]),
    JSON.stringify(events[0]?.payload?.foldedIds),
  );
  check(
    "…and the summary it left",
    events[0]?.payload?.headerId === "t-summary",
    events[0]?.payload?.headerId,
  );
  check(
    "every id the log names is one the transcript actually has",
    [events[0]?.payload?.headerId, ...(events[0]?.payload?.foldedIds ?? [])].every(
      (id) => t.ids.includes(id),
    ),
    { log: [events[0]?.payload?.headerId, ...(events[0]?.payload?.foldedIds ?? [])], transcript: t.ids },
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
