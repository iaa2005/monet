/**
 * Announce the tools ToolSearch is hiding.
 *
 * With ToolSearch enabled, MCP tools are kept out of the standing schema until
 * the model reveals them (vendor-tools.ts). That saves real context, but it
 * shipped without telling the model the hidden tools EXIST — and a capability
 * the model cannot see is, from where it sits, a capability the app does not
 * have.
 *
 * The observed failure: a user with a connected Dropbox connector (20 tools
 * behind the remote MCP server) asked to upload a file. The model saw no
 * Dropbox tool, never thought to search for one, and answered with an invented
 * architectural limit — "the Dropbox connector is only available to routines"
 * — which appears nowhere in this codebase. It did not lie about the file; it
 * reasoned correctly from a toolset that lied to it.
 *
 * So: publish the inventory as NAMES only. For the Dropbox server that is
 * ~120 tokens against ~2000 for its schemas, so deferral keeps ~94% of its
 * benefit while the model can actually find what it has.
 */

/** Deliberately dependency-free: the wording is the part that has to be right
 * and the part types cannot check, so it must be drivable from a probe without
 * dragging in the connector registry (and its icon imports) behind it. The live
 * lookups live in vendor-tools.ts, which already holds all four of them. */

/** Past this many tools on one server, list a sample and the count instead of
 * every name — the point is discoverability, not a full manifest. */
export const SAMPLE_AFTER = 12;

export interface DeferredTool {
  serverName: string;
  fullName: string;
}

/** Group tools by server, preserving first-seen order. */
function byServer(tools: DeferredTool[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of tools) {
    const list = out.get(t.serverName);
    if (list) list.push(t.fullName);
    else out.set(t.serverName, [t.fullName]);
  }
  return out;
}

/**
 * The directive text, or "" when there is nothing to say.
 *
 * Exported separately from the live lookups so it can be driven with a fixed
 * tool list in a probe — the wording is the part that has to be right, and it
 * is the part that cannot be checked by types.
 */
export function deferredLines(
  tools: DeferredTool[],
  label: (serverName: string) => string,
): { server: string; line: string }[] {
  return [...byServer(tools)].map(([server, names]) => {
    const shown =
      names.length > SAMPLE_AFTER
        ? `${names.slice(0, SAMPLE_AFTER).join(", ")} … and ${names.length - SAMPLE_AFTER} more`
        : names.join(", ");
    const name = label(server);
    const title = name === server ? server : `${name} (${server})`;
    return { server, line: `- ${title}: ${shown}` };
  });
}

export function renderDeferredDirective(
  tools: DeferredTool[],
  label: (serverName: string) => string,
): string {
  if (tools.length === 0) return "";
  const lines = deferredLines(tools, label).map((l) => l.line);
  return [
    "# Tools not yet loaded",
    "",
    "These tools are connected and available, but their schemas are NOT in your",
    "toolset yet, so calling one directly will fail. Load what you need first",
    'with ToolSearch — `select:<name>,<name>` for exact names, or keywords —',
    "then call it on the next turn.",
    "",
    ...lines,
    "",
    "This list is what you HAVE. If a request needs one of these, load it and",
    "use it. Never tell the user a capability is missing, restricted, or",
    "unavailable in this context when it appears above — and never invent a",
    "reason why it might be.",
  ].join("\n");
}
