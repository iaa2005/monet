/** Name the phase that eats a frame: a devtools timeline trace, top events. */
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
let id = 0; const pending = new Map(); const events = [];
ws.on("message", (b) => {
  const m = JSON.parse(b.toString());
  if (m.method === "Tracing.dataCollected") events.push(...m.params.value);
  if (m.method === "Tracing.tracingComplete") pending.get("done")?.();
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r) => ws.on("open", r));
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evalJs = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;

if (process.argv[2]) await evalJs(readFileSync(process.argv[2], "utf-8"));
await send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline", transferMode: "ReportEvents" });
await evalJs(readFileSync(process.argv[3], "utf-8"));
const done = new Promise((r) => pending.set("done", r));
await send("Tracing.end");
await done;

const byName = new Map();
for (const e of events) {
  if (e.ph !== "X" || !e.dur) continue;
  const k = e.name;
  const cur = byName.get(k) ?? { total: 0, count: 0, max: 0 };
  cur.total += e.dur / 1000; cur.count++; cur.max = Math.max(cur.max, e.dur / 1000);
  byName.set(k, cur);
}
// The single worst event, with its neighbours — a total is a symptom, the
// sequence is the cause.
const worst = events
  .filter((e) => e.ph === "X" && e.dur)
  .sort((a, b) => b.dur - a.dur)[0];
if (worst) {
  const t0 = worst.ts;
  const near = events
    .filter((e) => e.ph === "X" && e.dur > 2000 && Math.abs(e.ts - t0) < 2_000_000)
    .sort((a, b) => a.ts - b.ts)
    .slice(0, 14);
  console.log(`worst: ${worst.name} ${(worst.dur / 1000).toFixed(0)}ms`);
  console.log("around it:");
  for (const e of near)
    console.log(
      `  ${((e.ts - t0) / 1000).toFixed(0).padStart(6)}ms  ${(e.dur / 1000).toFixed(0).padStart(5)}ms  ${e.name}` +
        (e.args?.data?.type ? ` (${e.args.data.type})` : "") +
        (e.args?.data?.frame ? "" : ""),
    );
}

console.log(`${events.length} trace events. Heaviest:`);
for (const [name, v] of [...byName.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 12))
  console.log(`  ${v.total.toFixed(0).padStart(6)}ms total  ${v.max.toFixed(0).padStart(5)}ms worst  ×${String(v.count).padStart(4)}  ${name}`);
ws.close();
