/**
 * Does a file card look like a file? — checked in the running renderer over
 * CDP (`npx electron-vite dev -- --remote-debugging-port=9222`).
 *
 * Three things the user asked for that are only true on screen, so this asks
 * the screen: the tab wears the flow icon for its type, a preview tab is
 * italic until it is pinned, and the card's body no longer repeats the name
 * and the close button the tab already carries.
 */
import { WebSocket } from "ws";

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
const evalJs = (expression) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, (m) =>
      res(
        m.error
          ? { protocolError: m.error }
          : m.result?.exceptionDetails
            ? { thrown: m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text }
            : (m.result?.result?.value ?? { raw: m.result?.result }),
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
  const { useViewerStore } = await import("/stores/viewerStore.ts");
  const { useDockStore } = await import("/dock/dock-store.ts");

  const openPreview = (name, path) =>
    useViewerStore.getState().open(
      { name, path, mediaType: "application/octet-stream", kind: "file", source: "file" },
      { preview: true },
    );

  const read = (t) => {
    const label = t.querySelector("span[title]");
    const img = t.querySelector("img");
    return {
      title: (label?.textContent ?? t.textContent).trim(),
      italic: label ? getComputedStyle(label).fontStyle === "italic" : null,
      icon: img ? img.getAttribute("src") : null,
      iconBroken: img ? img.complete && img.naturalWidth === 0 : null,
    };
  };
  const tabs = () => [...document.querySelectorAll(".dv-tab")].map(read);

  // Start from an empty desk — a card left pinned by an earlier run would
  // otherwise look like a preview card that failed to be reused.
  useViewerStore.getState().closeAll();
  await sleep(500);

  // Single click #1: a preview card.
  openPreview("package.json", "D:/Projects/claude-code/desktop/package.json");
  await sleep(1500);
  const first = tabs();

  // Single click #2: the SAME card, renamed — no second file card.
  openPreview("tsconfig.json", "D:/Projects/claude-code/desktop/tsconfig.json");
  await sleep(1500);
  const second = tabs();

  // Double-clicking the tab pins it, and the italic goes.
  // Dispatch on the LABEL: an event fired at .dv-tab itself never reaches the
  // handler inside it, which is a property of dispatchEvent, not of the app.
  const fileTab = [...document.querySelectorAll(".dv-tab")].find((t) => read(t).icon);
  const target = fileTab?.querySelector("span[title]") ?? fileTab;
  target?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window, detail: 2 }));
  await sleep(600);
  const pinned = tabs();

  // And the other half of the idiom, driven through the tree itself: a click
  // previews (italic), a double click keeps (upright).
  useViewerStore.getState().closeAll();
  await sleep(400);
  const fire = (el) => {
    for (const t of ["pointerdown", "mousedown", "mouseup", "click"])
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  };
  const filesTab = () =>
    [...document.querySelectorAll(".dv-tab")].find((t) => t.textContent.includes("Files"));
  // The tree only exists in a Code chat; Home's Files panel lists a sandbox.
  const codeBtn = [...document.querySelectorAll("button")].find(
    (b) => (b.getAttribute("title") ?? b.textContent.trim()) === "Code",
  );
  if (codeBtn) {
    fire(codeBtn);
    await sleep(2000);
  }
  if (!filesTab()) {
    // The topbar button TOGGLES the panel — only press it when it is closed.
    const btn = [...document.querySelectorAll("button")].find((b) =>
      (b.getAttribute("title") ?? "").startsWith("Files"),
    );
    if (btn) fire(btn);
    await sleep(1200);
  }
  const ft = filesTab();
  if (ft) fire(ft);
  // The tree lists the workspace over IPC — wait for rows rather than guess.
  for (let i = 0; i < 20 && !document.querySelector("img[src*='icons/']"); i++)
    await sleep(300);
  // The tree is windowed and folders sort first, so the files are below the
  // fold until it is scrolled.
  const scroller = [...document.querySelectorAll("div")].find(
    (d) => d.scrollHeight > d.clientHeight + 50 && d.querySelector("img[src*='icons/']"),
  );
  if (scroller) {
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(700);
  }
  const fileRow = [...document.querySelectorAll("img[src*='icons/']")]
    .map((i) => i.parentElement)
    .find((row) => /\\.(ts|tsx|json|md|js|txt)$/.test(row?.textContent?.trim() ?? ""));
  let treeClick = null;
  let treeDouble = null;
  if (fileRow) {
    fire(fileRow);
    await sleep(1500);
    treeClick = tabs().find((t) => t.icon) ?? null;
    fileRow.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window, detail: 2 }));
    await sleep(1200);
    treeDouble = tabs().find((t) => t.icon) ?? null;
  }

  // The card's own chrome must not repeat what the tab says. Look at the
  // panel holding the editor, minus the editor itself — the file's CONTENT is
  // allowed to mention its name, the chrome around it is not.
  const editorPanel = document
    .querySelector(".monaco-editor")
    ?.closest(".dv-content-container");
  let chromeText = "";
  let closeInBody = -1;
  if (editorPanel) {
    const clone = editorPanel.cloneNode(true);
    clone.querySelectorAll(".monaco-editor").forEach((e) => e.remove());
    chromeText = clone.textContent ?? "";
    closeInBody = [...editorPanel.querySelectorAll("button")].filter(
      (b) =>
        !b.closest(".monaco-editor") &&
        ((b.getAttribute("title") ?? b.getAttribute("aria-label") ?? "").toLowerCase()).includes("close"),
    ).length;
  }
  const openName = useViewerStore.getState().docs[0]?.file.name ?? "";

  return {
    docs: useViewerStore.getState().docs.map((d) => ({ id: d.id, name: d.file.name, preview: d.preview })),
    dockOpen: useDockStore.getState().open,
    first,
    second,
    pinned,
    treeClick,
    treeDouble,
    treeDiag: {
      filesTabPresent: !!filesTab(),
      iconRows: [...document.querySelectorAll("img[src*='icons/']")].length,
      sampleRows: [...document.querySelectorAll("img[src*='icons/']")]
        .slice(-8)
        .map((i) => i.parentElement?.textContent?.trim().slice(0, 24)),
      scrolled: !!scroller,
    },
    bodyRepeatsName: !!openName && chromeText.includes(openName),
    editorPanelFound: !!editorPanel,
    closeButtonsInBody: closeInBody,
    monaco: !!document.querySelector(".monaco-editor"),
  };
})()`);

ws.close();

if (out?.thrown || out?.protocolError) {
  console.error(JSON.stringify(out, null, 2));
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

const fileTab = (row) => row.find((t) => t.icon);

check("a file card wears its type's flow icon", /icons\/.*\/nodejs\.svg$/.test(fileTab(out.first)?.icon ?? ""), fileTab(out.first)?.icon);
check("and the icon file exists", fileTab(out.first)?.iconBroken === false);
check("a different type gets a different icon", fileTab(out.second)?.icon !== fileTab(out.first)?.icon, [
  fileTab(out.first)?.icon,
  fileTab(out.second)?.icon,
]);
check("a preview card's name is italic", fileTab(out.second)?.italic === true);
check("a second single click reuses the one preview card", out.second.filter((t) => t.icon).length === 1);
check("double-clicking the tab pins it", fileTab(out.pinned)?.italic === false);
check("clicking in the tree previews (italic)", out.treeClick?.italic === true, out.treeClick);
check("double-clicking in the tree keeps it (upright)", out.treeDouble?.italic === false, out.treeDouble);
check("the editor card is on screen", out.editorPanelFound === true);
check("the card body no longer repeats the file name", out.bodyRepeatsName === false);
check("and has no close button of its own", out.closeButtonsInBody === 0, out.closeButtonsInBody);

console.log(failures === 0 ? "\nALL TAB CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
