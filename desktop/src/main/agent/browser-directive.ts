/**
 * What the model should know about the browser before it asks.
 *
 * Two failures this prevents. Asked to "check the page", a model with no
 * context starts its own dev server on the next free port and reports on that
 * one — the mistake Cursor calls out by name in their browser docs. And a model
 * that cannot see the panel opens a second tab for a page the user already has
 * in front of them, losing their scroll position and their login.
 *
 * The dev-server scan is cached and refreshed in the background: it probes a
 * dozen ports, which is far too slow to sit in the path of building a prompt.
 */

import { getBrowserConfig } from "../browser/config.js";
import { detectDevServers, type DevServer } from "../browser/dev-servers.js";
import { listTabs } from "../browser/registry.js";
import { readServers } from "../browser/servers.js";
import { getWorkspacePath } from "../ipc/workspace.js";

const REFRESH_MS = 60_000;

let cache: { at: number; servers: DevServer[] } = { at: 0, servers: [] };
let scanning = false;

function refreshIfStale(workspace: string): void {
  if (scanning || Date.now() - cache.at < REFRESH_MS) return;
  scanning = true;
  void detectDevServers(workspace)
    .then((servers) => {
      cache = { at: Date.now(), servers };
    })
    .catch(() => {
      cache = { at: Date.now(), servers: [] };
    })
    .finally(() => {
      scanning = false;
    });
}

/** The browser section of the system prompt, or "" when there is nothing to say. */
export function browserDirective(): string {
  const cfg = getBrowserConfig();
  if (!cfg.enabled) return "";

  const workspace = getWorkspacePath();
  refreshIfStale(workspace);

  const lines: string[] = [];
  const tabs = cfg.engine === "embedded" ? listTabs() : [];

  if (tabs.length > 0) {
    lines.push("Open in the Browser panel:");
    for (const t of tabs)
      lines.push(
        `  ${t.active ? "*" : " "} ${t.title || "(untitled)"} — ${t.url}`,
      );
    lines.push("  (* is the tab the browser tools act on.)");
  } else if (cfg.engine === "embedded") {
    lines.push("The Browser panel has no page open yet.");
  } else {
    lines.push("The browser tools drive a separate Chrome window.");
  }

  if (cache.servers.length > 0) {
    lines.push(
      "",
      "Dev servers already running — use these rather than starting another:",
    );
    for (const s of cache.servers)
      lines.push(`  ${s.url}${s.title ? `  (${s.title})` : ""}`);
  }

  // What the project SAYS it has, whether or not it is up. A declared server
  // that is down is worth naming: the answer is for the user to start it from
  // the panel, not for the agent to invent its own copy on another port.
  const declared = readServers(workspace);
  const idle = declared.filter(
    (d) => !cache.servers.some((s) => s.port === d.port),
  );
  if (idle.length > 0) {
    lines.push(
      "",
      "Declared in this project but NOT running (the user starts these from the Browser panel):",
    );
    for (const d of idle) lines.push(`  ${d.name} — \`${d.command}\` on :${d.port}`);
  }

  return `<browser>\n${lines.join("\n")}\n</browser>`;
}
