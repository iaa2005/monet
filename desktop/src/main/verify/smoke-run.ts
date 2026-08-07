/**
 * The window half of "actually run it".
 *
 * Starts the project's dev server through the app's own server store — the
 * same path the Browser panel and the DevServer tool use, so the process is
 * owned, listed and stopped with the app rather than left holding a port —
 * then loads the page in a BrowserWindow that is never shown and listens.
 *
 * Deliberately a real window, not a fetch of the HTML: the failures this
 * exists to catch happen after the HTML arrives. A page that 200s and then
 * throws on its first render looks perfect to a fetch.
 *
 * Everything here fails OPEN. A dev server that will not start, a port that
 * never answers, a window that dies — none of that is the user's change
 * being wrong, and reporting it as such would be worse than not looking.
 */

import { BrowserWindow } from "electron";
import {
  judgeSmoke,
  pickServer,
  requestProblem,
  WATCH_MS,
  type ServerCandidate,
  type SmokeOutcome,
  type SmokeProblem,
} from "./smoke.js";

/** Find, start and open the project's dev server. Never throws. */
export async function runSmoke(
  cwd: string,
  isAborted: () => boolean,
): Promise<SmokeOutcome> {
  try {
    return await smoke(cwd, isAborted);
  } catch (err) {
    return {
      status: "skipped",
      problems: [],
      reason: err instanceof Error ? err.message : "the app could not be started",
    };
  }
}

async function smoke(
  cwd: string,
  isAborted: () => boolean,
): Promise<SmokeOutcome> {
  const { readServers, suggestFromPackage, startAndWait, writeServers } =
    await import("../browser/servers.js");
  const { readFileSync, existsSync } = await import("fs");
  const { join } = await import("path");

  // What the project declares, or what its package.json implies. Never the
  // model: the harness starting a process stays bounded by what the project
  // already tells any developer to run.
  let servers: ServerCandidate[] = readServers(cwd) as ServerCandidate[];
  if (servers.length === 0) {
    const pkg = join(cwd, "package.json");
    if (!existsSync(pkg))
      return { status: "skipped", problems: [], reason: "no dev server in this project" };
    try {
      const found = suggestFromPackage(readFileSync(pkg, "utf-8")) as ServerCandidate[];
      if (found.length === 0)
        return {
          status: "skipped",
          problems: [],
          reason: "no dev server in this project",
        };
      // Remember them, so the panel lists what was started rather than a
      // process nobody can see.
      writeServers(cwd, found as never);
      servers = found;
    } catch {
      return { status: "skipped", problems: [], reason: "no dev server in this project" };
    }
  }

  const server = pickServer(servers);
  if (!server)
    return { status: "skipped", problems: [], reason: "no dev server in this project" };
  if (isAborted()) return { status: "skipped", problems: [], reason: "stopped" };

  const started = await startAndWait(cwd, server.id, 90_000);
  if (!started.ok)
    return {
      status: "skipped",
      problems: [],
      reason: started.error ?? "the dev server did not start",
    };
  if (isAborted()) return { status: "skipped", problems: [], reason: "stopped" };

  const url = `http://localhost:${started.port ?? server.port}/`;
  return watchPage(url, isAborted);
}

/** Open the page out of sight and collect what goes wrong. */
async function watchPage(
  url: string,
  isAborted: () => boolean,
): Promise<SmokeOutcome> {
  const problems: SmokeProblem[] = [];
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      // Nothing of ours is exposed to the page: this is somebody's app being
      // looked at, not a surface of this one.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A partition of its own, so a smoke run cannot read or write the
      // cookies and storage of the user's real browsing.
      partition: `smoke-${Date.now()}`,
    },
  });

  try {
    win.webContents.on(
      "console-message",
      (_e, level: number, message: string) => {
        if (level >= 3) problems.push({ kind: "console", text: message });
      },
    );
    win.webContents.on("render-process-gone", (_e, details) => {
      problems.push({ kind: "load", text: `the page crashed (${details.reason})` });
    });
    win.webContents.session.webRequest.onCompleted((details) => {
      const p = requestProblem(details.url, details.statusCode);
      if (p) problems.push({ kind: "request", text: p });
    });

    try {
      await win.loadURL(url);
    } catch (err) {
      problems.push({
        kind: "load",
        text: `${url} — ${err instanceof Error ? err.message : "did not load"}`,
      });
      return judgeSmoke(url, problems);
    }

    // Watch it live for a moment: the interesting failures happen after the
    // HTML arrives, on the first render and its first requests.
    const step = 250;
    for (let waited = 0; waited < WATCH_MS; waited += step) {
      if (isAborted() || win.isDestroyed()) break;
      await new Promise((r) => setTimeout(r, step));
    }

    // A page that renders nothing at all is a failure a console can miss —
    // a framework that swallowed the error and mounted an empty root.
    if (!win.isDestroyed()) {
      try {
        const text = (await win.webContents.executeJavaScript(
          "document.body ? document.body.innerText.trim().length : 0",
          true,
        )) as number;
        if (text === 0)
          problems.push({
            kind: "empty",
            text: "the page rendered no text at all",
          });
      } catch {
        /* the page may have navigated away — not evidence of anything */
      }
    }

    return judgeSmoke(url, problems);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
