/** Which phase eats the time: script, style, or layout. */
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
ws.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.on("open", r));
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evalJs = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;

if (process.argv[2]) await evalJs(readFileSync(process.argv[2], "utf-8"));
await send("Performance.enable");
const grab = async () => Object.fromEntries((await send("Performance.getMetrics")).result.metrics.map((m) => [m.name, m.value]));
const before = await grab();
await evalJs(readFileSync(process.argv[3], "utf-8"));
const after = await grab();
const d = (k) => +(((after[k] ?? 0) - (before[k] ?? 0)) * 1000).toFixed(0);
console.log({
  scriptMs: d("ScriptDuration"),
  recalcStyleMs: d("RecalcStyleDuration"),
  layoutMs: d("LayoutDuration"),
  taskMs: d("TaskDuration"),
  layoutCount: (after.LayoutCount ?? 0) - (before.LayoutCount ?? 0),
  styleRecalcs: (after.RecalcStyleCount ?? 0) - (before.RecalcStyleCount ?? 0),
  nodes: after.Nodes,
});
ws.close();
