/**
 * Drives the real chatStore under Node with a stubbed electronAPI, to check
 * what a Retry / Edit actually sends.
 *
 * The bug this exists for: resendFrom rebuilt the turn from its TEXT only, so
 * retrying a message with attachments resent it without them — the files
 * vanished from the bubble and the model never saw them again.
 */

import { useChatStore } from "@/stores/chatStore";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}`);
    if (detail !== undefined) console.log("      ", JSON.stringify(detail));
  }
}

// ─── Stub the preload bridge ────────────────────────────────────────────

interface SentPayload {
  message: string;
  /** The bubble this prompt was drawn as. Without it the transcript mints its
   * own id, nothing matches, and the turn can never be named again. */
  userMessageId?: string;
  mode?: string;
  attachments?: {
    name: string;
    kind: string;
    text?: string;
    dataBase64?: string;
  }[];
}

/** What rewindTranscript was asked to cut at — the id of the prompt being
 * resent, never anything derived from counting the messages around it. */
const cuts: { beforePromptId: string }[] = [];

const sent: SentPayload[] = [];
const DISK: Record<string, { text?: string; base64?: string }> = {
  "artifacts/s1/1-notes.txt": { text: "line one\nline two" },
  "artifacts/s1/2-plan.pdf": { base64: Buffer.from("%PDF-1.4 fake").toString("base64") },
};

const bridge = {
  chat: {
    send: async (p: SentPayload) => {
      sent.push(p);
      return { ok: true };
    },
    rewindTranscript: async (_id: string, beforePromptId: string) => {
      cuts.push({ beforePromptId });
      return { ok: true as const, removed: 2 };
    },
  },
  artifacts: {
    readText: async (path: string) =>
      DISK[path]?.text != null
        ? { ok: true, content: DISK[path].text }
        : { ok: false as const },
    readBytes: async (path: string) =>
      DISK[path]?.base64 != null
        ? { ok: true, base64: DISK[path].base64 }
        : { ok: false as const },
  },
  sessions: { getById: async () => null, save: async () => {} },
};

(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { electronAPI: unknown }).electronAPI = bridge;
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

// ─── Seed a session: a user turn WITH attachments, then a reply ─────────

const store = useChatStore.getState();
store.setCurrentSessionId("s1");
const userMsg = store.addUserMessage("summarise these", [
  {
    name: "notes.txt",
    mediaType: "text/plain",
    kind: "text",
    path: "artifacts/s1/1-notes.txt",
  },
  {
    name: "plan.pdf",
    mediaType: "application/pdf",
    kind: "file",
    path: "artifacts/s1/2-plan.pdf",
  },
  {
    name: "gone.png",
    mediaType: "image/png",
    kind: "image",
    path: "artifacts/s1/missing.png",
  },
]);
useChatStore.getState().startStreaming();
useChatStore
  .getState()
  .handleLLMEvent("s1", { type: "text_delta", text: "here is a summary" });
useChatStore
  .getState()
  .handleLLMEvent("s1", { type: "message_stop", stop_reason: "end_turn" });
useChatStore.getState().finishStreaming();

const before = useChatStore.getState().messages;
check("seeded a user turn and a reply", before.length === 2, before.map((m) => m.role));
check("the user turn carries 3 attachments", before[0].attachments?.length === 3);

// ─── Retry it ──────────────────────────────────────────────────────────

await useChatStore.getState().resendFrom(userMsg.id);

const after = useChatStore.getState().messages;
check(
  "the reply was dropped and the prompt resent",
  after.length === 1 && after[0].role === "user",
  after.map((m) => m.role),
);
check(
  "the resent bubble still shows its attachments",
  after[0].attachments?.length === 3,
  after[0].attachments?.map((a) => a.name),
);

check("exactly one send went out", sent.length === 1, sent.length);
const payload = sent[0];
check("the send carried the text", payload.message === "summarise these");
// THE THREAD BETWEEN THE TWO SIDES.
//
// The transcript tags its user turn with this id, and every affordance that
// names a turn later — take this prompt out of context, put it back — is a
// lookup by it. A send without it produces a turn nothing can point at.
check(
  "the send named the bubble it was drawn as",
  payload.userMessageId === after[0].id,
  { sent: payload.userMessageId, bubble: after[0].id },
);
// A retry is a send, and it runs under the mode the picker is showing.
// Omitting it does not mean "keep the mode": main reads absent as "default"
// AND writes that back as the session's live mode, so Retry used to drop a
// chat out of accept-edits without saying so.
check("the send carried a permission mode", typeof payload.mode === "string", payload.mode);
check(
  "the send carried all 3 attachments",
  payload.attachments?.length === 3,
  payload.attachments?.map((a) => a.name),
);

const txt = payload.attachments?.find((a) => a.name === "notes.txt");
check(
  "the text attachment was re-read from disk",
  txt?.text === "line one\nline two",
  txt,
);

const pdf = payload.attachments?.find((a) => a.name === "plan.pdf");
check(
  "the binary attachment was re-read as base64",
  pdf?.dataBase64 === DISK["artifacts/s1/2-plan.pdf"].base64,
  pdf?.dataBase64?.slice(0, 20),
);

const missing = payload.attachments?.find((a) => a.name === "gone.png");
check(
  "an unreadable attachment becomes a visible note, not silence",
  missing?.kind === "text" && /could not be re-read/.test(missing.text ?? ""),
  missing,
);

// ─── Edit (same path, different text) ──────────────────────────────────

sent.length = 0;
// The retry left the chat streaming (nothing here answers). resendFrom
// refuses to rewind mid-stream — correctly — so end the turn first.
useChatStore.getState().finishStreaming();
const again = useChatStore.getState().messages[0];
await useChatStore.getState().resendFrom(again.id, "summarise the pdf only");
check(
  "editing resends the new text and keeps the files",
  sent[0]?.message === "summarise the pdf only" &&
    sent[0]?.attachments?.length === 3,
  { message: sent[0]?.message, n: sent[0]?.attachments?.length },
);

// ─── A MID-RUN NOTE IS NOT A PROMPT ────────────────────────────────────
//
// Ctrl+S hands text to a turn already running. The chat draws it as a user
// message — it is the user's words — but it starts no turn: it rides along
// with the tool results of the turn it interrupted. A retry of the prompt
// before it must cut AT that prompt's id, unmoved by the note sitting
// between them. (When cuts were counted rather than anchored, this note
// drifted the count and every later Rewind in the chat refused, forever.)
{
  useChatStore.getState().finishStreaming();
  useChatStore.getState().clearMessages();
  cuts.length = 0;
  sent.length = 0;

  const first = useChatStore.getState().addUserMessage("do the thing");
  useChatStore.getState().startStreaming();
  useChatStore
    .getState()
    .handleLLMEvent("s1", { type: "user_message", content: "wait — use v2", injected: true });
  useChatStore
    .getState()
    .handleLLMEvent("s1", { type: "text_delta", text: "done" });
  useChatStore.getState().finishStreaming();

  // (Streamed text is buffered and flushed on a timer, so the assistant
  // bubble is not here yet — the note is what this case is about.)
  const msgs = useChatStore.getState().messages;
  check(
    "the note is on screen, as the user's own message",
    msgs[1]?.role === "user" && msgs[1]?.content === "wait — use v2",
    msgs.map((m) => `${m.role}${m.injected ? "(injected)" : ""}`),
  );
  check("…and it is marked as said mid-run", msgs[1]?.injected === true);

  await useChatStore.getState().resendFrom(first.id);
  check(
    "THE NOTE DOES NOT MOVE WHERE THE CUT LANDS",
    cuts.length === 1 && cuts[0].beforePromptId === first.id,
    cuts[0],
  );
}

console.log(failures === 0 ? "\nALL RETRY CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
