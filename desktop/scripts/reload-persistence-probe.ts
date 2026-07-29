/**
 * Losing the first half of a chat to a renderer reload.
 *
 * Reported live: the app reloaded abruptly mid-conversation and the earlier
 * half of the chat was gone afterwards. Losing the TAIL is the ordinary failure
 * mode; losing the HEAD meant something had overwritten history, not failed to
 * append to it.
 *
 * The mechanism, and it is not a dev-only accident:
 *
 *   1. the agent runs in the MAIN process and keeps streaming across a renderer
 *      reload — that is a deliberate feature (background chats);
 *   2. a reload throws away the Zustand store, so `sessions` is empty;
 *   3. `chat:token` events keep arriving, and the reducer builds a fresh buffer
 *      for the session out of `EMPTY` — i.e. the tail of the current run alone;
 *   4. `message_stop` fires `persistSession`, and `SessionStore.save()` is
 *      DELETE-all-rows + INSERT-what-you-were-given.
 *
 * Everything before the reload is deleted by step 4. Anything that resets the
 * renderer while a run continues does this: a crash and reload, a devtools
 * reload, an OOM'd renderer process.
 *
 * These checks model that sequence against the merge rule now in
 * persistSession, and separate it from the truncations that MUST still be
 * honoured — retry, edit, /undo all legitimately shorten a chat.
 */

import { mergeForSave } from "../src/renderer/stores/merge-for-save";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const m = (id: string, content = id): Msg => ({ id, role: "user", content });

/** The real rule persistSession applies — imported, not re-implemented. */
const toSave = (
  buffer: Msg[],
  hydrated: boolean,
  dbRows: Msg[] | undefined,
): Msg[] => mergeForSave(buffer, hydrated, dbRows);

const ids = (list: Msg[]): string => list.map((x) => x.id).join(",");

// ── 1. The reported sequence ──────────────────────────────────────────
{
  // Ten messages exchanged, then the renderer reloads mid-run and the store
  // comes back knowing only what streamed after it.
  const before = ["u1", "a1", "u2", "a2", "u3", "a3"].map((i) => m(i));
  const afterReload = ["a4"].map((i) => m(i));

  const saved = toSave(afterReload, false, before);
  check(
    "the pre-reload half survives",
    before.every((x) => saved.some((y) => y.id === x.id)),
    ids(saved),
  );
  check("the post-reload part is kept too", saved.some((x) => x.id === "a4"));
  check("history stays in order, oldest first", ids(saved) === "u1,a1,u2,a2,u3,a3,a4", ids(saved));
  check("nothing is duplicated", new Set(saved.map((x) => x.id)).size === saved.length);

  // What the old code did, for contrast: the buffer went to save() verbatim.
  check(
    "and the old behaviour really did lose it",
    ids(afterReload) === "a4",
    "save() deletes every row for the session, then inserts what it is given",
  );
}

// ── 2. Deliberate truncation must still win ───────────────────────────
{
  // Retry / edit / undo shorten a HYDRATED buffer on purpose. Re-adding the
  // dropped messages here would resurrect exactly what the user removed.
  const db = ["u1", "a1", "u2", "a2"].map((i) => m(i));
  const afterUndo = ["u1", "a1"].map((i) => m(i));
  const saved = toSave(afterUndo, true, db);
  check("a hydrated buffer is saved as-is", ids(saved) === "u1,a1", ids(saved));
  check("undone messages are not resurrected", !saved.some((x) => x.id === "u2"));
}

// ── 3. A brand-new chat is not confused by an empty row ───────────────
{
  const saved = toSave([m("u1")], false, []);
  check("nothing to merge, nothing changes", ids(saved) === "u1", ids(saved));
  check("an absent row is handled too", ids(toSave([m("u1")], false, undefined)) === "u1");
}

// ── 4. The overlapping case: some of ours is already on disk ──────────
{
  // A throttled tool_result save landed before the reload, so the DB holds part
  // of what the fresh buffer also has. The overlap must not double up, and OUR
  // copy must win — it is the newer one (a streaming message grows).
  const db = [m("u1"), m("a1"), { ...m("a2"), content: "half" }];
  const buffer = [{ ...m("a2"), content: "complete" }, m("a3")];
  const saved = toSave(buffer, false, db);
  check("the overlap appears once", ids(saved) === "u1,a1,a2,a3", ids(saved));
  check(
    "and keeps the newer copy, not the stale row",
    saved.find((x) => x.id === "a2")?.content === "complete",
    saved.find((x) => x.id === "a2")?.content,
  );
}

// ── 5. Idempotence: saving twice must not grow the chat ───────────────
{
  const db = ["u1", "a1"].map((i) => m(i));
  const once = toSave([m("a2")], false, db);
  // After the first save the buffer is marked hydrated, so the second is a
  // plain write of the merged list.
  const twice = toSave(once, true, once);
  check("a second save changes nothing", ids(twice) === ids(once), ids(twice));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL RELOAD-PERSISTENCE CHECKS PASSED");
process.exit(failures ? 1 : 0);
