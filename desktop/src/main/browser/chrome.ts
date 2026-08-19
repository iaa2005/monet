/**
 * Managed browser instance for Browser Use.
 *
 * Launches Chrome (or Edge — same CDP) with a SEPARATE profile under the app
 * data dir and a remote-debugging port. The user's own browser profile is
 * never touched; the instance is killed when the app quits.
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getDataSubdir } from "../data-dir.js";

const DEBUG_PORT = 9333;

function candidates(): string[] {
  if (process.platform === "darwin") {
    const home = process.env.HOME ?? "";
    const mac = (app: string, bin: string): string =>
      join("/Applications", app, "Contents", "MacOS", bin);
    return [
      process.env.CHROME_PATH,
      mac("Google Chrome.app", "Google Chrome"),
      home ? join(home, mac("Google Chrome.app", "Google Chrome")) : "",
      mac("Chromium.app", "Chromium"),
      // Edge is Chromium too — same CDP.
      mac("Microsoft Edge.app", "Microsoft Edge"),
      mac("Brave Browser.app", "Brave Browser"),
    ].filter((c): c is string => !!c);
  }
  if (process.platform === "linux") {
    return [
      process.env.CHROME_PATH,
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    ].filter((c): c is string => !!c);
  }
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? "";
  return [
    process.env.CHROME_PATH,
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    local ? join(local, "Google", "Chrome", "Application", "chrome.exe") : "",
    // Edge is Chromium too and ships with Windows — solid fallback.
    join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter((c): c is string => !!c);
}

let proc: ChildProcess | null = null;
let wsUrl: string | null = null;

async function debuggerUp(): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { webSocketDebuggerUrl?: string };
    return data.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

/** Launch (or reuse) the managed browser; resolves the browser-level CDP URL. */
export async function ensureBrowser(): Promise<string> {
  // Already running (ours from earlier, or a previous app run left it up).
  const up = await debuggerUp();
  if (up) {
    wsUrl = up;
    return up;
  }

  const exe = candidates().find((c) => existsSync(c));
  if (!exe) {
    throw new Error(
      "No Chrome or Edge found. Install Google Chrome (or set CHROME_PATH).",
    );
  }

  const profile = join(getDataSubdir("browser"), "profile");
  if (!existsSync(profile)) mkdirSync(profile, { recursive: true });

  proc = spawn(
    exe,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=ChromeWhatsNewUI",
      "--window-size=1280,900",
      "about:blank",
    ],
    { windowsHide: false, stdio: "ignore" },
  );
  proc.once("exit", () => {
    proc = null;
    wsUrl = null;
  });

  // The debugger endpoint takes a moment to come up.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const url = await debuggerUp();
    if (url) {
      wsUrl = url;
      return url;
    }
  }
  throw new Error("Browser started but the DevTools endpoint never came up.");
}

export function browserWsUrl(): string | null {
  return wsUrl;
}

/** Kill the managed instance (app quit). Best-effort. */
export function shutdownBrowser(): void {
  try {
    proc?.kill();
  } catch {
    /* already gone */
  }
  proc = null;
  wsUrl = null;
}
