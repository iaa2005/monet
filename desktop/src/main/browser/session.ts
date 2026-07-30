/**
 * Which Chromium session store the Browser panel uses.
 *
 * Cookies are the whole point: you log into your staging app once and the
 * agent finds you logged in next time. That makes the partition name a
 * correctness question, not a formality — two workspaces sharing a name share
 * their logins, and a name that changes with the path's spelling silently logs
 * you out. Hence: normalise the path (Windows differs in case AND slashes),
 * then hash it.
 *
 * Pure on purpose, so the naming rule can be asserted without Electron.
 */

import { createHash } from "crypto";
import type { BrowserPersist } from "./config.js";

/** Stable id for a workspace path, insensitive to case and slash direction. */
export function workspaceKey(workspace: string): string {
  const normal = workspace
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  return createHash("sha1").update(normal).digest("hex").slice(0, 12);
}

/**
 * The Electron partition string for a tab.
 *
 * A name WITHOUT the `persist:` prefix is in-memory and dies with the app —
 * that is exactly what "don't keep" means, so it needs no separate cleanup.
 */
export function partitionFor(opts: {
  mode: BrowserPersist;
  workspace: string;
  sessionId?: string;
}): string {
  const key = workspaceKey(opts.workspace);
  switch (opts.mode) {
    case "none":
      return "monet-browser-ephemeral";
    case "perChat":
      // No chat yet (blank composer) still needs a store; falling back to the
      // shared one would leak that browsing into every later chat, so give the
      // unsaved chat its own ephemeral store instead.
      return opts.sessionId
        ? `persist:monet-browser-${key}-${opts.sessionId}`
        : "monet-browser-ephemeral";
    case "shared":
    default:
      return `persist:monet-browser-${key}`;
  }
}
