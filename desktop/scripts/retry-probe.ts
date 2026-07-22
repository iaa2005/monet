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
  attachments?: {
    name: string;
    kind: string;
    text?: string;
    dataBase64?: string;
  }[];
}

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
    rewindTranscript: async () => ({ fidelity: "full" as const, removed: 2 }),
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

console.log(failures === 0 ? "\nALL RETRY CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 1 - 1 : 1);
