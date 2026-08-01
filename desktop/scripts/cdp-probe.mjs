/**
 * Drive the REAL app (production build) over the DevTools protocol.
 *
 * The dev renderer in a plain browser is not the app: no Electron, no
 * preload, a different React build. When a user says "the whole program
 * stops responding", the honest measurement is the shipped renderer, with
 * its own main process behind it.
 *
 * Launch the app with --remote-debugging-port=9222, then run this.
 */
import { WebSocket } from "ws";

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.log("no page target — is the app running with --remote-debugging-port=9222?");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();
ws.on("message", (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
await new Promise((r) => ws.on("open", r));
const send = (method, params = {}) =>
  new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
await send("Page.bringToFront").catch(() => {});

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails)
    return "ERROR: " + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text).slice(0, 300);
  return r.result?.result?.value;
};

export { evalJs, send, ws };

if (process.argv[2] === "--script") {
  const code = (await import("node:fs")).readFileSync(process.argv[3], "utf-8");
  console.log(await evalJs(code));
  ws.close();
}
