/**
 * A slash command is coloured; a slash in a sentence is not.
 *
 * Run against the app — `npx electron-vite dev -- --remote-debugging-port=9222`.
 * The rule lives in the composer, but the PAINT is a browser feature (the CSS
 * Custom Highlight API): the range has to exist, cover exactly the command,
 * and be registered under the name the stylesheet paints. None of that is
 * visible from a unit test.
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

  const box = document.querySelector("[contenteditable]");
  if (!box) return { error: "no composer" };

  // Type the way a person does: text in, input event out. setComposerDraft
  // would take a different path (a full re-render) and prove less.
  const type = async (text) => {
    box.focus();
    box.textContent = text;
    box.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await sleep(250);
  };
  const painted = () => {
    const hl = CSS.highlights?.get("monet-command");
    if (!hl) return null;
    const range = [...hl][0];
    return range ? range.toString() : null;
  };

  const cases = {};
  for (const [name, text] of [
    ["command", "/compact"],
    ["commandWithArgs", "/rename my chat"],
    ["namespaced", "/git:commit now"],
    ["pathFirst", "/etc/hosts is broken"],
    ["slashInside", "look in src/renderer/App.tsx"],
    ["bareSlash", "/"],
    ["plain", "hello there"],
  ]) {
    await type(text);
    cases[name] = painted();
  }

  // And the colour actually reaches the glyphs.
  await type("/compact");
  const styled = getComputedStyle(box, "::highlight(monet-command)").color;

  box.textContent = "";
  box.dispatchEvent(new InputEvent("input", { bubbles: true }));
  useChatStore.getState().setComposerDraft("");
  return { cases, styled };
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

const c = out.cases ?? {};
check("a command is painted", c.command === "/compact", c.command);
check("its arguments are not", c.commandWithArgs === "/rename", c.commandWithArgs);
check("a namespaced command counts", c.namespaced === "/git:commit", c.namespaced);
check("a path typed first is not a command", c.pathFirst === null, c.pathFirst);
check("nor is a slash inside a sentence", c.slashInside === null, c.slashInside);
check("nor is a bare slash", c.bareSlash === null, c.bareSlash);
check("and plain text is left alone", c.plain === null, c.plain);
check("the paint has a colour", !!out.styled && out.styled !== "rgba(0, 0, 0, 0)", out.styled);

console.log(failures === 0 ? "\nALL COMMAND-HIGHLIGHT CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
