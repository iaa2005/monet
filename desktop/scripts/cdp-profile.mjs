/** CPU profile of one action in the real app, top self-time functions. */
import { WebSocket } from "ws";
const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();
ws.on("message", (b) => {
  const m = JSON.parse(b.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r) => ws.on("open", r));
const send = (method, params = {}) =>
  new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evalJs = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

const setup = process.argv[2];
const action = process.argv[3];
if (setup) await evalJs((await import("node:fs")).readFileSync(setup, "utf-8"));

await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 200 });
await send("Profiler.start");
await evalJs((await import("node:fs")).readFileSync(action, "utf-8"));
const { result } = await send("Profiler.stop");
const profile = result.profile;

const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const total = profile.samples.length;
for (const sid of profile.samples) {
  const n = byId.get(sid);
  if (!n) continue;
  const f = n.callFrame;
  const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber}`;
  self.set(key, (self.get(key) ?? 0) + 1);
}
const ms = (profile.endTime - profile.startTime) / 1000;
console.log(`profile: ${Math.round(ms)}ms, ${total} samples`);
for (const [k, c] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`  ${((c / total) * 100).toFixed(1)}%  ${k}`);
ws.close();
