/**
 * What can still be done with a message that has not been sent yet.
 *
 * Two chips sit under a running turn. A QUEUED message waits for the run to
 * end; an INJECTED one was handed to the run and waits for its next step
 * boundary. Between them they cover the whole "I typed it while it was busy"
 * case, and until now they carried one control: a button that deleted the
 * queued one and threw away what had been typed.
 *
 * The three things this checks are the three ways that goes wrong:
 *
 *   1. Moving a queued message into the run must not lose its files — the
 *      encoded payload lives in a module-level map keyed by message id, so a
 *      move that forgets to look it up silently drops the attachments.
 *   2. Taking a note back is MAIN's decision, not the chat's: the run may
 *      have read it at a step boundary a moment ago. A chip removed for a
 *      note the model then reads is the one lie this row exists to avoid.
 *   3. Editing must hand the words back, not just delete the bubble.
 *
 *   npm run smoke:pending
 */

import { useChatStore } from "@/stores/chatStore";

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

/** Every inject/cancel the store sent to main, in order. */
const injects: { text: string; attachments?: unknown[] }[] = [];
const cancels: string[] = [];
/** What main answers next — flipped per case, the way a real run would. */
let injectOk = true;
let cancelOk = true;
let aborted = 0;

const bridge = {
  sessions: {
    getById: async () => null,
    save: async () => {},
    updateTitle: async () => {},
  },
  chat: {
    inject: async (
      _sid: string,
      text: string,
      attachments?: unknown[],
    ): Promise<{ ok: boolean; id?: string }> => {
      injects.push({ text, attachments });
      return injectOk ? { ok: true, id: `note-${injects.length}` } : { ok: false };
    },
    cancelInject: async (
      _sid: string,
      id: string,
    ): Promise<{ ok: boolean; text?: string }> => {
      cancels.push(id);
      return cancelOk ? { ok: true, text: "the words back" } : { ok: false };
    },
    abort: async (): Promise<{ ok: boolean }> => {
      aborted++;
      return { ok: true };
    },
  },
};

(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { electronAPI: unknown }).electronAPI = bridge;
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const store = (): ReturnType<typeof useChatStore.getState> =>
  useChatStore.getState();
const FILE = [
  {
    name: "shot.png",
    mediaType: "image/png",
    kind: "image" as const,
    dataBase64: "AAAA",
  },
];

store().setCurrentSessionId("s1");

// ─── The queue, before anything is done to it ───────────────────────────

store().enqueueMessage("s1", "first");
store().enqueueMessage("s1", "second");
store().enqueueMessage("s1", "third");
check(
  "three messages queued, in the order typed",
  store().queue.map((m) => m.content).join() === "first,second,third",
  store().queue.map((m) => m.content),
);

// ─── Send now: promote, then stop the run ───────────────────────────────
//
// Nothing here sends anything. Aborting drains the queue, and the queue
// drains from the FRONT — so "send this one now" is "put it at the front,
// then stop", and everything else keeps its place behind it.

{
  const third = store().queue[2]!.id;
  store().promoteQueued("s1", third);
  check(
    "the promoted message is now first",
    store().queue.map((m) => m.content).join() === "third,first,second",
    store().queue.map((m) => m.content),
  );
  check("and the others keep their order", store().queue.length === 3);
  store().promoteQueued("s1", "no-such-id");
  check(
    "promoting something that is not there changes nothing",
    store().queue.map((m) => m.content).join() === "third,first,second",
  );
}

// ─── Edit: the words come back ──────────────────────────────────────────

{
  const first = store().queue.find((m) => m.content === "first")!.id;
  const text = store().unqueueForEdit("s1", first);
  check("editing hands the text back", text === "first", text);
  check(
    "…and takes the message out of the queue",
    !store().queue.some((m) => m.id === first),
    store().queue.map((m) => m.content),
  );
  check(
    "editing something already gone says so",
    store().unqueueForEdit("s1", first) === null,
  );
}

// ─── Say it now: the queue hands the message to the running turn ────────

{
  store().enqueueMessage("s1", "look at this", FILE, FILE);
  const withFile = store().queue.find((m) => m.content === "look at this")!.id;
  const moved = await store().handQueuedToRun("s1", withFile);
  check("the move is accepted while a run is going", moved);
  check(
    "main was asked to inject the same words",
    injects.at(-1)?.text === "look at this",
  );
  check(
    "AND THE FILES WENT WITH IT — the payload map was consulted",
    (injects.at(-1)?.attachments as unknown[] | undefined)?.length === 1,
    injects.at(-1)?.attachments,
  );
  check(
    "the message left the queue",
    !store().queue.some((m) => m.id === withFile),
    store().queue.map((m) => m.content),
  );
  check(
    "…and became a pending injection, keeping its id so the chip does not blink",
    store().pendingInjections.some((m) => m.id === withFile),
    store().pendingInjections.map((m) => m.content),
  );
}

// The run can end between the render and the click. Then there is nothing to
// join, and the queue is about to drain by itself — so the message stays.
{
  injectOk = false;
  store().enqueueMessage("s1", "too late");
  const late = store().queue.find((m) => m.content === "too late")!.id;
  const moved = await store().handQueuedToRun("s1", late);
  check("an idle run refuses the hand-off", !moved);
  check(
    "…and the message is STILL QUEUED, not lost",
    store().queue.some((m) => m.id === late),
    store().queue.map((m) => m.content),
  );
  store().dequeueMessage("s1", late);
  injectOk = true;
}

// ─── Taking a note back is main's decision ──────────────────────────────

{
  const pending = store().pendingInjections[0]!.id;
  const text = await store().cancelPendingInjection("s1", pending);
  check(
    "cancelling gives the words back for the composer",
    text === "the words back",
    text,
  );
  check("main was the one asked", cancels.length === 1, cancels);
  check(
    "…and the chip is gone",
    !store().pendingInjections.some((m) => m.id === pending),
    store().pendingInjections.length,
  );
}

// The half that matters: main says the run already read it.
{
  store().addPendingInjection("s1", "already read", undefined, "note-live");
  const chip = store().pendingInjections.at(-1)!.id;
  cancelOk = false;
  const text = await store().cancelPendingInjection("s1", chip);
  check("a note the run has read cannot be taken back", text === null, text);
  check(
    "AND THE CHIP STAYS — it is going to be delivered, so it keeps saying so",
    store().pendingInjections.some((m) => m.id === chip),
    store().pendingInjections.map((m) => m.content),
  );
  cancelOk = true;
}

// A chip from before this build has no id from main, so there is nothing to
// cancel. It must not silently vanish from the screen either.
{
  store().addPendingInjection("s1", "no handle");
  const chip = store().pendingInjections.at(-1)!.id;
  const before = cancels.length;
  const text = await store().cancelPendingInjection("s1", chip);
  check("a note with no id from main is not cancellable", text === null);
  check("…and main is not asked about it", cancels.length === before);
  check(
    "…and it stays on screen",
    store().pendingInjections.some((m) => m.id === chip),
  );
}

check("nothing in this probe stopped a run by accident", aborted === 0, aborted);

console.log(
  failures ? `\n${failures} FAILED` : "\nALL PENDING-MESSAGE CHECKS PASSED",
);
process.exit(failures ? 1 : 0);
