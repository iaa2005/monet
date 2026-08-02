/**
 * Coming back to a chat is coming back to a DESK.
 *
 * Run against the app — `npx electron-vite dev -- --remote-debugging-port=9222`.
 * The layout half of this only exists at runtime: dockview serialises groups,
 * splits and sizes, the sanitiser filters them, and the viewer's own cards are
 * recreated from the session's state. This arranges a desk the way a person
 * would, leaves the chat, comes back, and asks whether it looks the same.
 */
import { WebSocket } from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const DIR = tmpdir().split("\\").join("/") + "/monet-desk-probe";
mkdirSync(DIR, { recursive: true });
const A = DIR + "/alpha.ts";
const B = DIR + "/beta.ts";
writeFileSync(A, "export const alpha = 1;\n", "utf-8");
writeFileSync(B, "export const beta = 2;\n", "utf-8");

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.title.includes("Code Monet"));
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
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

// A fresh page, so the probe and the app share one module graph.
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
// Wait for the DOCK, not just the document: the app restores a session
// before the wing exists, and a probe that starts earlier finds no panels.
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if ((await evalJs(`!!document.querySelector(".dv-tab")`)) === true) break;
}
await new Promise((r) => setTimeout(r, 1500));

const out = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { useViewerStore } = await import("/stores/viewerStore.ts");
  // The app's OWN dock store. A module edited since the page loaded is served
  // with a ?t= stamp and imports as a SECOND instance — one with no dockview
  // api in it, which looks exactly like a dock that failed to start.
  const useDockStore =
    window.__monetDock ?? (await import("/dock/dock-store.ts")).useDockStore;

  const dock = () => useDockStore.getState();
  const api = () => dock().api;
  // The wing only exists once something is in it; opening a panel is what a
  // user does first anyway.
  if (!api()) {
    // The wing is a component: it only mounts once the user opens a panel,
    // so this presses the button rather than poking the store.
    const btn = [...document.querySelectorAll("button")].find((b) =>
      (b.getAttribute("title") ?? "").startsWith("Files"),
    );
    if (btn)
      for (const t of ["pointerdown", "mousedown", "mouseup", "click"])
        btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    for (let i = 0; i < 40 && !api(); i++) await sleep(300);
  }
  if (!api())
    return {
      error: "no dock api",
      viaGlobal: !!window.__monetDock,
      tabs: [...document.querySelectorAll(".dv-tab")].map((t) => t.textContent),
      open: dock().open,
      pending: JSON.stringify(dock().pending)?.slice(0, 80),
    };

  const file = (path) => ({
    name: path.split("/").pop(),
    path,
    mediaType: "application/octet-stream",
    kind: "file",
    source: "file",
  });

  // ── Arrange a desk: two files, the second dragged out into its own
  // group beside the first (which is what "split" means to dockview).
  useViewerStore.getState().closeAll();
  await sleep(400);
  useViewerStore.getState().open(file(${JSON.stringify(A)}), { preview: false });
  await sleep(900);
  useViewerStore.getState().open(file(${JSON.stringify(B)}), { preview: false });
  await sleep(900);

  const second = api().getPanel("viewer:2");
  if (!second) return { error: "no second card", panels: api().panels.map((p) => p.id) };
  const first = api().getPanel("viewer");
  api().addGroup({ referenceGroup: first.group, direction: "below" });
  const below = api().groups[api().groups.length - 1];
  second.api.moveTo({ group: below });
  await sleep(900);

  const shape = () => ({
    ids: api().panels.map((p) => p.id).sort(),
    groups: api().groups.length,
    // Which group each card sits in, by position rather than by identity —
    // group ids are regenerated on restore, the arrangement is what matters.
    cardGroups: api()
      .panels.filter((p) => /^viewer(:\\d+)?$/.test(p.id))
      .map((p) => ({
        id: p.id,
        title: p.title,
        top: Math.round(p.group.element.getBoundingClientRect().top),
        left: Math.round(p.group.element.getBoundingClientRect().left),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  const before = shape();
  const savedLayout = dock().layoutJson;

  // ── Leave and come back, the way App does on a chat switch.
  const docs = useViewerStore.getState().serialize();
  dock().applyDesk(null);
  useViewerStore.getState().closeAll();
  await sleep(800);
  const whileAway = shape();

  useViewerStore.getState().restore(docs);
  await sleep(400);
  dock().applyDesk({ kind: "layout", layout: savedLayout });
  await sleep(1200);
  const after = shape();

  // A layout that mentions a card the chat no longer has must not leave an
  // empty panel behind.
  useViewerStore.getState().closeAll();
  await sleep(400);
  dock().applyDesk({ kind: "layout", layout: savedLayout });
  await sleep(1200);
  const orphaned = api().panels.filter((p) => /^viewer(:\\d+)?$/.test(p.id)).length;

  useViewerStore.getState().closeAll();
  return { before, whileAway, after, orphaned };
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

check("two files were open, in two groups", out.before?.cardGroups?.length === 2 && out.before.groups >= 2, out.before);
check("leaving the chat clears the desk", (out.whileAway?.cardGroups?.length ?? -1) === 0, out.whileAway);
check("coming back brings both files", out.after?.cardGroups?.length === 2, out.after?.cardGroups);
check(
  "with their names",
  (out.after?.cardGroups ?? []).map((c) => c.title).join(",") ===
    (out.before?.cardGroups ?? []).map((c) => c.title).join(","),
  { was: out.before?.cardGroups?.map((c) => c.title), now: out.after?.cardGroups?.map((c) => c.title) },
);
check("and in the same arrangement, not stacked", out.after?.groups === out.before?.groups, {
  was: out.before?.groups,
  now: out.after?.groups,
});
check(
  "the split is still a split (one card below the other)",
  (out.after?.cardGroups?.[1]?.top ?? 0) > (out.after?.cardGroups?.[0]?.top ?? 0),
  out.after?.cardGroups,
);
check("a layout with no files behind it leaves no empty card", out.orphaned === 0, out.orphaned);

console.log(failures === 0 ? "\nALL DESK-RESTORE CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
