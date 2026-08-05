// Пишет каждую [voice]-строку консоли рендерера в файл, пока жив.
// Ждёт приложение и переподключается после его перезапуска.
import { WebSocket } from "ws";
import { appendFileSync, writeFileSync } from "node:fs";
const OUT = process.argv[2];
writeFileSync(OUT, `# voice log started ${new Date().toISOString()}\n`);

async function connectOnce() {
  const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://localhost"));
  if (!page) throw new Error("no page target");
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    let id = 0;
    ws.on("message", (b) => {
      const m = JSON.parse(b.toString());
      if (m.method !== "Runtime.consoleAPICalled") return;
      const args = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      if (!args.includes("[voice]") && !args.includes("[stt]")) return;
      appendFileSync(OUT, args.trim() + "\n");
    });
    ws.on("open", () => {
      appendFileSync(OUT, `# connected ${new Date().toISOString()}\n`);
      ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable" }));
    });
    ws.on("close", () => resolve());
    ws.on("error", (e) => reject(e));
  });
}

for (;;) {
  try {
    await connectOnce();
    appendFileSync(OUT, `# disconnected ${new Date().toISOString()}, waiting for app...\n`);
  } catch {
    /* app not up yet */
  }
  await new Promise((r) => setTimeout(r, 2000));
}
