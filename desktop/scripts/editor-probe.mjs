/**
 * The editor, in the running app — `npx electron-vite dev -- --remote-debugging-port=9222`.
 *
 * Every claim here is one a user can make with their hands, and none of them
 * can be checked without a real renderer: typing changes the file on disk,
 * Home cannot type at all, and the completion list contains a symbol that is
 * declared in ANOTHER file — which is the whole point of loading the import
 * graph, and the difference between completions and a word list.
 */
import { WebSocket } from "ws";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// OUTSIDE the repo: vite watches it, and a new file under the root reloads
// the page in the middle of the measurement.
const DIR = tmpdir().split("\\").join("/") + "/monet-editor-probe";
const HELPER = DIR + "/helper.ts";
const MAIN = DIR + "/main.ts";
mkdirSync(DIR, { recursive: true });
writeFileSync(
  HELPER,
  [
    "export interface Sunflower {",
    "  petalCount: number;",
    "  facingSun: boolean;",
    "}",
    "",
    "export function plantSunflower(): Sunflower {",
    "  return { petalCount: 34, facingSun: true };",
    "}",
    "",
  ].join("\n"),
  "utf-8",
);
writeFileSync(
  MAIN,
  [
    'import { plantSunflower } from "./helper";',
    "",
    "const flower = plantSunflower();",
    "flower.",
    "",
  ].join("\n"),
  "utf-8",
);

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.title.includes("Code Monet"));
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.on("open", r));
let id = 0;
const pending = new Map();
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.id && pending.has(m.id)) pending.get(m.id)(m);
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const evalJs = (expression) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, (m) =>
      res(
        m.result?.exceptionDetails
          ? {
              thrown:
                m.result.exceptionDetails.exception?.description ??
                m.result.exceptionDetails.text,
            }
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

// A fresh page: workers are created once per language and cached, so a
// reload is the only way to measure the environment this code actually sets
// up rather than one left over from a previous edit.
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const ready = await evalJs(
    `document.readyState === "complete" && !!document.querySelector(".dv-tab")`,
  );
  if (ready === true) break;
}
await new Promise((r) => setTimeout(r, 1500));

const out = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { useViewerStore } = await import("/stores/viewerStore.ts");
  const { useChatStore } = await import("/stores/chatStore.ts");
  // The app's OWN monaco instance. Vite's dep URLs carry a ?v= hash, and
  // importing the path without it yields a second copy of the editor with no
  // models in it — which looks exactly like a broken app.
  const depUrl = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .find((n) => n.includes("deps/monaco-editor.js"));
  if (!depUrl) return { error: "monaco not loaded in the page" };
  const monaco = await import(depUrl);

  const open = (path) =>
    useViewerStore.getState().open(
      {
        name: path.split("/").pop(),
        path,
        mediaType: "application/octet-stream",
        kind: "file",
        source: "file",
      },
      { preview: false },
    );
  const editorNow = () => monaco.editor.getEditors().find((e) => e.getDomNode()?.isConnected);

  useViewerStore.getState().closeAll();
  useChatStore.getState().setSpace("code");
  await sleep(600);
  open(${JSON.stringify(MAIN)});
  for (let i = 0; i < 30 && !editorNow(); i++) await sleep(200);
  await sleep(1500);

  const ed = editorNow();
  if (!ed)
    return {
      error: "no editor",
      docs: useViewerStore.getState().docs.map((d) => d.file.name),
      editors: monaco.editor.getEditors().length,
      models: monaco.editor.getModels().map((m) => m.uri.toString()).slice(0, 5),
      dom: !!document.querySelector(".monaco-editor"),
    };
  const readOnlyInCode = ed.getOption(monaco.editor.EditorOption.readOnly);

  // ── completions from ANOTHER file ────────────────────────────────
  // The model is main.ts; the members offered after "flower." can only come
  // from helper.ts, which the import graph loaded.
  const model = ed.getModel();
  const dotLine = model.getLineCount() - 1;
  ed.setPosition({ lineNumber: 4, column: 8 });
  let suggestions = [];
  let completionError = null;
  try {
    const worker = await (await monaco.typescript.getTypeScriptWorker())(model.uri);
    const offset = model.getOffsetAt({ lineNumber: 4, column: 8 });
    const info = await worker.getCompletionsAtPosition(model.uri.toString(), offset);
    suggestions = (info?.entries ?? []).map((e) => e.name);
  } catch (e) {
    // A TS request answered by the BASE editor worker throws exactly this;
    // it is a failed check, not a broken probe.
    completionError = String(e?.message ?? e);
  }

  // ── typing marks the card dirty, Ctrl+S writes the file ──────────
  const docId = useViewerStore.getState().docs[0]?.id;
  ed.setPosition({ lineNumber: 5, column: 1 });
  ed.trigger("probe", "type", { text: "export const grown = true;" });
  await sleep(500);
  const dirtyAfterTyping = !!useViewerStore.getState().docs.find((d) => d.id === docId)?.dirty;
  const dot = !!document.querySelector('.dv-tab [title="Unsaved changes"]');

  ed.getAction("monet.save")?.run();
  await sleep(900);
  const dirtyAfterSave = !!useViewerStore.getState().docs.find((d) => d.id === docId)?.dirty;

  // ── selection offers itself to the chat ──────────────────────────
  ed.setSelection(new monaco.Selection(1, 1, 2, 1));
  await sleep(500);
  const addButton = [...document.querySelectorAll("button")].find((b) =>
    b.textContent.includes("Add to chat"),
  );
  const hasAddAction = !!ed.getAction("monet.addToChat");

  // ── Home cannot edit ─────────────────────────────────────────────
  useChatStore.getState().setSpace("home");
  await sleep(900);
  const readOnlyInHome = editorNow()?.getOption(monaco.editor.EditorOption.readOnly);
  useChatStore.getState().setSpace("code");

  return {
    readOnlyInCode,
    suggestions: suggestions.filter((s) => s === "petalCount" || s === "facingSun"),
    suggestionCount: suggestions.length,
    completionError,
    dirtyAfterTyping,
    dot,
    dirtyAfterSave,
    addButton: !!addButton,
    hasAddAction,
    readOnlyInHome,
  };
})()`);

ws.close();

if (out?.thrown || out?.error) {
  console.error(JSON.stringify(out, null, 2));
  process.exit(1);
}

const onDisk = readFileSync(MAIN, "utf-8");
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

check("a file in Code opens editable", out.readOnlyInCode === false);
check(
  "completions come from another file in the project",
  out.suggestions.includes("petalCount") && out.suggestions.includes("facingSun"),
  { got: out.suggestions, total: out.suggestionCount, error: out.completionError },
);
check("typing marks the card unsaved", out.dirtyAfterTyping === true);
check("and the tab shows the dot", out.dot === true);
check("saving clears it", out.dirtyAfterSave === false);
check("and the file on disk has the edit", onDisk.includes("export const grown = true;"));
check("a selection offers itself to the chat", out.addButton === true);
check("and the same offer is an editor action", out.hasAddAction === true);
check("Home cannot edit the project", out.readOnlyInHome === true);

rmSync(DIR, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL EDITOR CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
