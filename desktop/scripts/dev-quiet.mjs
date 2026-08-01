/**
 * `npm run dev` — electron-vite dev with the known DevTools noise filtered.
 *
 * Opening DevTools in any Electron app prints protocol chatter Chromium
 * cannot satisfy: the DevTools frontend enables Autofill.* domains Electron
 * does not implement, and it fetches source-map helpers from
 * chrome-devtools-frontend.appspot.com that 404. None of it is ours and none
 * of it is actionable, but it lands as ERROR:CONSOLE lines between real
 * errors. This wrapper drops EXACTLY those lines and forwards everything
 * else byte-for-byte (`dev:raw` bypasses it when the raw stream matters).
 */
import { spawn } from "node:child_process";

const NOISE = [
  // DevTools protocol domains Electron does not implement.
  /ERROR:CONSOLE.*Request Autofill\.\w+ failed/,
  // Anything the DevTools frontend logs about itself.
  /ERROR:CONSOLE.*source: devtools:\/\/devtools\//,
];

const child = spawn("npx electron-vite dev", {
  shell: true,
  env: { ...process.env, FORCE_COLOR: "1" },
  stdio: ["inherit", "pipe", "pipe"],
});

function filterTo(out) {
  let tail = "";
  return (chunk) => {
    const text = tail + chunk.toString();
    const lines = text.split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) {
      if (NOISE.some((re) => re.test(line))) continue;
      out.write(line + "\n");
    }
  };
}

child.stdout.on("data", filterTo(process.stdout));
child.stderr.on("data", filterTo(process.stderr));
child.on("exit", (code) => process.exit(code ?? 0));
