/** Is the renderer compositing on the GPU, or in software? */
import { WebSocket } from "ws";
const t = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
ws.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.on("open", r));
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const info = (await send("SystemInfo.getInfo")).result;
const gpu = info?.gpu ?? {};
console.log("driver:", (gpu.devices ?? []).map((d) => `${d.vendorString || d.vendorId} ${d.deviceString || d.deviceId}`).join(" | ") || "none");
const fs = gpu.featureStatus ?? {};
for (const k of ["gpu_compositing", "rasterization", "multiple_raster_threads", "opengl", "webgl", "canvas"])
  if (fs[k]) console.log(`  ${k}: ${fs[k]}`);
if ((gpu.driverBugWorkarounds ?? []).length)
  console.log("workarounds:", gpu.driverBugWorkarounds.slice(0, 6).join(", "));
ws.close();
