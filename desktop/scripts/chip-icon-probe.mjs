/**
 * The chips, on screen — `npx electron-vite dev -- --remote-debugging-port=9222`.
 *
 * The offline probe proves the four kinds have four icons. It cannot prove
 * that the composer PICKS the right one: that depends on the kind travelling
 * from the context block, through the store, into a node built by hand with
 * createElement. This asks the composer.
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
  const { codeRef, fileRef, chatRef } = await import("/lib/refs.ts");

  const store = useChatStore.getState();
  // Start clean: chips from an earlier run would be counted as this one's.
  store.clearPendingContext();
  await sleep(300);

  const chipFor = (label) =>
    [...document.querySelectorAll("[data-monet-chip]")].find(
      (el) => el.getAttribute("data-monet-chip") === label,
    );
  const iconOf = (label) => {
    const el = chipFor(label);
    const svg = el?.querySelector("svg");
    return svg ? svg.innerHTML.replace(/\\s+/g, " ").trim() : null;
  };

  // One of each kind, through the real path: a pending context entry, which
  // the composer turns into a chip.
  useChatStore.getState().addPendingContext(
    codeRef({ path: "src/a.ts", name: "a.ts", startLine: 3, endLine: 9, snippet: "const x = 1;" }),
  );
  await sleep(400);
  // A file and a chat arrive PRETOKENISED: the @-mention puts the token in
  // the sentence itself, so their chips are drawn from TEXT — the path where
  // the label is all the chip has to go on.
  useChatStore.getState().addPendingContext(fileRef("src/b.ts", "b.ts"));
  useChatStore.getState().addPendingContext(chatRef("sess-1", "Old chat"));
  await sleep(400);
  useChatStore.getState().addPendingContext({
    id: "probe-browser",
    label: "SaveButton",
    count: 1,
    tone: 2,
    url: "http://localhost/x",
    context: '<selected-from-browser label="SaveButton" tone="2">a button</selected-from-browser>',
  });
  await sleep(500);

  // The colour a chip is wearing BEFORE anything re-renders the composer.
  const colourOf = (label) => {
    const el = chipFor(label);
    return el ? getComputedStyle(el).backgroundColor : null;
  };
  const coloursBefore = {
    code: colourOf("a.ts:3-9"),
    browser: colourOf("SaveButton"),
  };

  // One sentence carrying all four tokens. Rendering from TEXT is the hard
  // case: the chip has nothing but the label to decide what it is.
  useChatStore
    .getState()
    .setComposerDraft(
      "⟨a.ts:3-9⟩ ⟨b.ts⟩ ⟨Old chat⟩ ⟨SaveButton⟩",
    );
  await sleep(800);

  const icons = {
    code: iconOf("a.ts:3-9"),
    file: iconOf("b.ts"),
    chat: iconOf("Old chat"),
    browser: iconOf("SaveButton"),
  };
  const chipCount = document.querySelectorAll("[data-monet-chip]").length;
  const coloursAfter = {
    code: colourOf("a.ts:3-9"),
    browser: colourOf("SaveButton"),
  };

  // …and after the selections are gone, which is what sending does. A chip
  // still standing in the composer must not change under the user.
  useChatStore.getState().clearPendingContext();
  await sleep(200);
  useChatStore
    .getState()
    .setComposerDraft(
      "⟨a.ts:3-9⟩ ⟨b.ts⟩ ⟨Old chat⟩ ⟨SaveButton⟩ after",
    );
  await sleep(700);
  const coloursOrphaned = {
    code: colourOf("a.ts:3-9"),
    browser: colourOf("SaveButton"),
  };
  const iconsOrphaned = {
    code: iconOf("a.ts:3-9"),
    file: iconOf("b.ts"),
    chat: iconOf("Old chat"),
    browser: iconOf("SaveButton"),
  };

  // Leave the composer as it was found.
  useChatStore.getState().clearPendingContext();
  useChatStore.getState().setComposerDraft("");

  return { icons, chipCount, coloursBefore, coloursAfter, coloursOrphaned, iconsOrphaned };
})()`);

ws.close();

if (out?.thrown) {
  console.error(JSON.stringify(out, null, 2));
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

const { icons = {} } = out ?? {};
check("all four chips are on screen", out?.chipCount >= 4, out?.chipCount);
for (const kind of ["code", "file", "chat", "browser"])
  check(`the ${kind} chip has an icon`, !!icons[kind]);
check(
  "and each kind wears a different one",
  new Set(Object.values(icons).filter(Boolean)).size === 4,
  icons,
);

// Reported from use: a chip changed colour by itself. It was drawn in the
// tick its selection was registered, missed its own tone, and took the
// label's hash — until the next re-render handed it the real one.
check(
  "a chip keeps its colour when the composer re-renders",
  !!out.coloursBefore?.code &&
    out.coloursBefore.code === out.coloursAfter?.code &&
    out.coloursBefore.browser === out.coloursAfter?.browser,
  { before: out.coloursBefore, after: out.coloursAfter },
);

// And after the selections are gone — which is what sending does. A chip
// still standing in the composer redrew as a grey browser pick, reported as
// chips losing their colour and icon after a command was confirmed.
check(
  "a chip keeps its colour after its selection is gone",
  out.coloursOrphaned?.code === out.coloursBefore?.code &&
    out.coloursOrphaned?.browser === out.coloursBefore?.browser,
  { was: out.coloursBefore, now: out.coloursOrphaned },
);
check(
  "and keeps its icon too",
  JSON.stringify(out.iconsOrphaned) === JSON.stringify(out.icons),
  out.iconsOrphaned,
);

console.log(failures === 0 ? "\nALL CHIP-ICON CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
