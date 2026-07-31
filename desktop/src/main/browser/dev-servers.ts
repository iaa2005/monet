/**
 * Finding the dev server the user already has running.
 *
 * Two failure modes this exists to prevent. The user opens the Browser panel
 * and has to remember which port today's project uses. And the agent, asked to
 * "check the page", starts a SECOND dev server on the next free port and then
 * reports on the wrong one — the mistake Cursor calls out explicitly in their
 * browser docs.
 *
 * Ports come from two places: the workspace's own package.json scripts (the
 * authoritative answer when a project pins one) and a list of defaults. Both
 * are only candidates — a port counts as a dev server when something actually
 * answers HTTP on it.
 */

import { createConnection } from "net";
import { readFileSync } from "fs";
import { join } from "path";

export interface DevServer {
  port: number;
  url: string;
  title: string;
}

/** Ports the popular toolchains pick when nothing says otherwise. */
const COMMON_PORTS = [
  // 4173 is `vite preview`, which is what an agent reaches for after a build.
  3000, 3001, 4173, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 1313,
];

/** True when something is listening on 127.0.0.1:port. */
function portOpen(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Ports named in the workspace's own npm scripts (`--port 4000`, `-p 4000`).
 *
 * Exported for the probe: a project that pins a port is the case where guessing
 * from the defaults list is wrong, so this is the part worth pinning down.
 */
export function portsFromScripts(pkgJson: string): number[] {
  const out = new Set<number>();
  try {
    const pkg = JSON.parse(pkgJson) as { scripts?: Record<string, string> };
    for (const cmd of Object.values(pkg.scripts ?? {})) {
      if (typeof cmd !== "string") continue;
      for (const m of cmd.matchAll(/(?:--port[= ]|-p[= ]|PORT=)(\d{2,5})/g)) {
        const port = Number(m[1]);
        if (port >= 80 && port <= 65535) out.add(port);
      }
    }
  } catch {
    /* no package.json, or not JSON — the defaults still apply */
  }
  return [...out];
}

/** Ask the port what it is. A dev server answers HTML; a database does not. */
async function identify(port: number): Promise<DevServer | null> {
  const url = `http://localhost:${port}/`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(1500),
      redirect: "follow",
    });
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html")) return null;
    const body = await res.text();
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim() ?? "";
    return { port, url, title: title.slice(0, 80) };
  } catch {
    return null;
  }
}

/** Every local port currently serving HTML, most likely candidate first. */
export async function detectDevServers(workspace: string): Promise<DevServer[]> {
  let scripted: number[] = [];
  try {
    scripted = portsFromScripts(readFileSync(join(workspace, "package.json"), "utf-8"));
  } catch {
    /* not a node project */
  }
  // Scripted ports first: they are what THIS project says it uses, so they
  // stay ahead of the generic list in the result the user sees.
  const candidates = [...new Set([...scripted, ...COMMON_PORTS])];

  const open = (await Promise.all(candidates.map(portOpen)))
    .map((isOpen, i) => (isOpen ? candidates[i]! : 0))
    .filter((p): p is number => p > 0);

  const found = await Promise.all(open.map(identify));
  return found.filter((s): s is DevServer => s !== null);
}
