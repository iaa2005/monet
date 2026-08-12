/**
 * Events the engine emits about itself.
 *
 * The leak instruments almost everything: a hundred and eleven call sites
 * name what the agent just did — a tool refused, a hook fired, a compaction
 * ran, a shell command was only an echo. That instrumentation is worth
 * keeping. Where it went is not: the original ships it to Anthropic's event
 * pipeline (Datadog plus a first-party BigQuery exporter), which is the
 * single largest edge into src/anthropic and the reason that tree is in our
 * bundle at all.
 *
 * Worse, it was not even doing that here. Their logEvent queues into an array
 * until attachAnalyticsSink() runs, and the only two callers of that are MCP
 * server entrypoints the desktop never starts. So in the running app every
 * event pushed onto an unbounded queue that nothing ever drained.
 *
 * So: dropped by default, and visible when asked. Set MONET_TRACE_EVENTS=1
 * and the same hundred and eleven sites become a running commentary on the
 * turn, which is what they were always good for.
 */

/**
 * Marker type for metadata that has been checked not to contain code or file
 * paths. Declared `never` so a bare string cannot be passed by accident — the
 * cast is the developer's assertion that they looked.
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never;

/** Same idea, for values whose destination tolerates unredacted content. */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never;

type LogEventMetadata = Record<
  string,
  | string
  | number
  | boolean
  | undefined
  | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  | AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED
>;

const TRACING =
  !!process.env.MONET_TRACE_EVENTS &&
  process.env.MONET_TRACE_EVENTS !== "0" &&
  process.env.MONET_TRACE_EVENTS !== "false";

export function logEvent(
  eventName: string,
  metadata: LogEventMetadata = {},
): void {
  if (!TRACING) return;
  const fields = Object.entries(metadata)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  console.log(`[event] ${eventName}${fields ? " " + fields : ""}`);
}

/** The async form exists because the original sampled events before sending.
 *  Nothing is sent, so there is nothing to await. */
export async function logEventAsync(
  eventName: string,
  metadata: LogEventMetadata = {},
): Promise<void> {
  logEvent(eventName, metadata);
}

// ── Shaping event fields ──────────────────────────────────────────────────
// Upstream these guarded a pipeline: they exist so a tool name, a file path
// or a tool input could be logged without carrying code or user data with it.
// Nothing leaves this machine now, so their job is narrower — they keep the
// trace above readable — but the shapes are the ones the call sites expect,
// and collapsing an MCP tool to "mcp_tool" is still the right summary.

type Safe = AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
const safe = (s: string): Safe => s as unknown as Safe;

/** Every MCP tool reads as one name; there are thousands of the others. */
export function sanitizeToolNameForAnalytics(toolName: string): Safe {
  return safe(toolName.startsWith("mcp__") ? "mcp_tool" : toolName);
}

const MAX_EXTENSION = 20;

/** A path's extension, or nothing. Absurdly long ones become "other" — an
 *  extension that long is a filename fragment, not a type. */
export function getFileExtensionForAnalytics(
  filePath: string,
): Safe | undefined {
  const dot = filePath.lastIndexOf(".");
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (dot <= slash + 1) return undefined;
  const ext = filePath.slice(dot + 1).toLowerCase();
  if (!ext) return undefined;
  return safe(ext.length > MAX_EXTENSION ? "other" : ext);
}

/** The distinct extensions a shell command mentions, comma-joined. */
export function getFileExtensionsFromBashCommand(
  command: string,
  simulatedSedEditFilePath?: string,
): Safe | undefined {
  const seen = new Set<string>();
  const add = (p: string): void => {
    const ext = getFileExtensionForAnalytics(p);
    if (ext) seen.add(ext as unknown as string);
  };
  if (simulatedSedEditFilePath) add(simulatedSedEditFilePath);
  for (const word of command.split(/\s+/)) add(word);
  return seen.size ? safe([...seen].join(",")) : undefined;
}

/** mcp__<server>__<tool> split into its parts. */
export function extractMcpToolDetails(
  toolName: string,
): { serverName: Safe; mcpToolName: Safe } | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const rest = toolName.slice("mcp__".length);
  const at = rest.indexOf("__");
  if (at === -1) return undefined;
  return {
    serverName: safe(rest.slice(0, at)),
    mcpToolName: safe(rest.slice(at + 2)),
  };
}

export function mcpToolDetailsForAnalytics(
  toolName: string,
  _mcpServerType?: string,
  _mcpServerBaseUrl?: string,
): { mcpServerName?: Safe; mcpToolName?: Safe } {
  const d = extractMcpToolDetails(toolName);
  return d ? { mcpServerName: d.serverName, mcpToolName: d.mcpToolName } : {};
}

/** The skill a Skill tool call names. */
export function extractSkillName(
  toolName: string,
  input: unknown,
): Safe | undefined {
  if (toolName !== "Skill") return undefined;
  const name =
    input && typeof input === "object"
      ? (input as { command?: unknown; skill?: unknown }).command ??
        (input as { skill?: unknown }).skill
      : undefined;
  return typeof name === "string" && name ? safe(name) : undefined;
}

/** Tool inputs are code and user data by definition, so they are off unless
 *  explicitly turned on — same env var the original used. */
export function isToolDetailsLoggingEnabled(): boolean {
  const v = process.env.OTEL_LOG_TOOL_DETAILS;
  return !!v && v !== "0" && v !== "false";
}

const TOOL_INPUT_MAX_JSON_CHARS = 2_000;

export function extractToolInputForTelemetry(
  input: unknown,
): string | undefined {
  if (!isToolDetailsLoggingEnabled()) return undefined;
  let json: string;
  try {
    json = JSON.stringify(input) ?? "";
  } catch {
    return undefined;
  }
  return json.length > TOOL_INPUT_MAX_JSON_CHARS
    ? json.slice(0, TOOL_INPUT_MAX_JSON_CHARS) + "…[truncated]"
    : json;
}
