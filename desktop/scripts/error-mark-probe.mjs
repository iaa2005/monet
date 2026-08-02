/**
 * A chat that stopped on an error says so in the list.
 *
 * Run against the app — `npx electron-vite dev -- --remote-debugging-port=9222`.
 * The mark is driven by per-session store state, and the point of it is what
 * the SIDEBAR looks like — a probe over the store alone would prove nothing
 * about the row. So this puts a real chat into the error state and reads the
 * list, then continues the chat and reads it again.
 */
import { WebSocket } from "ws";

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.title.includes("Code Monet"));
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on("open", r));
let id = 0;
const pending = new Map();
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.id && pending.has(m.id)) pending.get(m.id)(m);
});
const evalJs = (expression) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, (m) =>
      res(
        m.result?.exceptionDetails
          ? { thrown: m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text }
          : m.result?.result?.value,
      ),
    );
    ws.send(
      JSON.stringify({
        id: i,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });

const out = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { useChatStore } = await import("/stores/chatStore.ts");

  // A row in the sidebar to mark. Whichever chat is on screen will do — the
  // list is rendered from the database, the mark from the store.
  // Any chat with a row in the sidebar. The current one if there is one,
  // otherwise the first the list shows — the mark is drawn per row.
  const rows = (await window.electronAPI.sessions.list(20, 0, undefined, "all")) ?? [];
  const sid = useChatStore.getState().currentSessionId ?? rows[0]?.id;
  if (!sid) return { error: "no session to mark", rows: rows.length };

  const marks = () =>
    document.querySelectorAll('[aria-label="Stopped with an error"]').length;
  const dots = () => document.querySelectorAll("span.rounded-full.size-1\\\\.5").length;

  // The sidebar fetches its rows; a snapshot taken before they arrive counts
  // zero dots and makes every comparison below meaningless.
  for (let i = 0; i < 40 && dots() === 0; i++) await sleep(300);
  const before = { marks: marks(), dots: dots() };
  if (before.dots === 0) return { error: "the session list never rendered" };

  // The chat dies mid-turn, the way a failed request leaves it.
  useChatStore.getState().handleLLMEvent(sid, {
    type: "error",
    error: "Probe: the model gave up",
  });
  await sleep(700);
  const afterError = { marks: marks(), dots: dots() };
  const storeError = !!useChatStore.getState().sessions[sid]?.error;

  // …and the user continues it, which is what clears the trouble: the next
  // turn starting is what resets the error.
  useChatStore.getState().handleLLMEvent(sid, {
    type: "text_delta",
    text: "continuing",
  });
  await sleep(700);
  const afterContinue = { marks: marks(), dots: dots() };

  // Leave the chat idle again, as it was found.
  useChatStore.getState().handleLLMEvent(sid, {
    type: "message_stop",
    stop_reason: "end_turn",
  });
  await sleep(300);

  // The database half: the row the sidebar reads carries what a failed chat
  // left behind, so a chat that died before the last restart still shows it.
  // (What WRITES it is main, on the turn that fails — see ipc/chat.ts.)
  const listed = (await window.electronAPI.sessions.list(20, 0, undefined, "all")) ?? [];
  const carriesField = listed.every(
    (r) => r.lastError === undefined || typeof r.lastError === "string",
  );

  return { before, afterError, afterContinue, storeError, sid, carriesField, listed: listed.length };
})()`);

ws.close();

if (out?.thrown || out?.error) {
  console.error(JSON.stringify(out, null, 2));
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

check("the chat is not marked to begin with", out.before?.marks === 0, out.before);
check("an error puts the chat into the error state", out.storeError === true);
check("and the list shows a warning", out.afterError?.marks === 1, out.afterError);
check(
  "which replaces the dot rather than joining it",
  out.afterError?.dots === (out.before?.dots ?? 0) - 1,
  { before: out.before?.dots, after: out.afterError?.dots },
);
check("continuing the chat takes the warning away", out.afterContinue?.marks === 0, out.afterContinue);
check(
  "and the dot comes back",
  out.afterContinue?.dots === out.before?.dots,
  { before: out.before?.dots, after: out.afterContinue?.dots },
);

// The stored half. What WRITES it is main, on the turn that fails; what this
// pins down is that the reason survives the trip to the renderer at all — a
// row that drops the field would leave a chat that died yesterday unmarked
// today, which is the whole point of storing it.
check(
  "the list rows carry the stored reason across the IPC boundary",
  out.carriesField === true && out.listed > 0,
  { rows: out.listed },
);

console.log(failures === 0 ? "\nALL ERROR-MARK CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
