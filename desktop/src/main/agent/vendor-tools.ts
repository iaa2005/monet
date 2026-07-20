/**
 * Vendor toolset — the real Claude Code tools from vendor/leaked, assembled
 * directly (vendor tools.ts is CLI-oriented: require() conditionals,
 * Tungsten/testing tools). Execution goes through the tools' own
 * validateInput → checkPermissions → call pipeline; results come back via
 * each tool's mapToolResultToToolResultBlockParam, flattened to text for the
 * LLM adapter layer.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { leanToolDescription } from "./lean-context.js";
import type { Tool, Tools, ToolUseContext } from "@vendor/Tool.js";
import { findToolByName } from "@vendor/Tool.js";
import { BashTool } from "@vendor/tools/BashTool/BashTool.js";
import { FileEditTool } from "@vendor/tools/FileEditTool/FileEditTool.js";
import { FileReadTool } from "@vendor/tools/FileReadTool/FileReadTool.js";
import { FileWriteTool } from "@vendor/tools/FileWriteTool/FileWriteTool.js";
import { GlobTool } from "@vendor/tools/GlobTool/GlobTool.js";
import { GrepTool } from "@vendor/tools/GrepTool/GrepTool.js";
import { PowerShellTool } from "@vendor/tools/PowerShellTool/PowerShellTool.js";
import { TodoWriteTool } from "@vendor/tools/TodoWriteTool/TodoWriteTool.js";
import { zodToJsonSchema } from "@vendor/utils/zodToJsonSchema.js";
import { InlineSkillTool } from "./skill-tool.js";
import { AgentTaskTool } from "./agent-tool.js";
import { SearchPastChatsTool } from "./memory-tools.js";
import { getMemoryConfig } from "../memory/store.js";
import type { SubAgentUpdate } from "./subagent.js";
import { WebFetchTool, WebSearchTool } from "./web-tools.js";
import { RunPythonTool } from "./sandbox-tool.js";
import { RunCommandTool } from "./podman-command-tool.js";
import {
  ListMcpResourcesTool,
  ReadMcpResourceTool,
} from "./mcp-resource-tools.js";
import { AskUserQuestionTool } from "./ask-user-tool.js";
import { ToolSearchTool } from "./tool-search-tool.js";
import { getToolSearchConfig } from "./toolsearch-config.js";
import { getRevealedTools } from "./revealed-tools.js";
import { LSPTool } from "./lsp-tool.js";
import { getLspConfig } from "./lsp/config.js";
import type { AskUserFn } from "../ipc/ask-user.js";
import { getSandboxConfig, getSessionEngine } from "../sandbox/config.js";
import {
  CONNECTOR_TOOLS,
  CONNECTOR_TOOL_NAMES,
  connectorToolNames,
  connectorToolHasAccounts,
} from "./connector-tools.js";
import { CreateRoutineTool } from "./routine-tool.js";
import { RememberTool } from "./remember-tool.js";
import {
  SandboxListTool,
  SandboxReadTool,
  SandboxWriteTool,
  SandboxEditTool,
} from "./sandbox-file-tools.js";
import { ensurePosixShell } from "./shell-env.js";
import {
  BrowserClickTool,
  BrowserNavigateTool,
  BrowserReadPageTool,
  BrowserScreenshotTool,
  BrowserScrollTool,
  BrowserTypeTool,
} from "./browser-tools.js";
import { getBrowserConfig } from "../browser/config.js";
import { ComputerTool } from "./computer-tools.js";
import { getComputerConfig } from "../computer/config.js";
import { getProviderManager } from "../provider/manager.js";

/** Tools advertised to Home (isolated space): no host filesystem/shell —
 * file access is scoped to the CHAT's sandbox via the Sandbox* tools. */
const HOME_TOOL_NAMES = new Set([
  "RunPython",
  "RunCommand",
  "SandboxList",
  "SandboxRead",
  "SandboxWrite",
  "SandboxEdit",
  "TodoWrite",
  "Skill",
  "AskUserQuestion",
  "WebFetch",
  "WebSearch",
  "SearchPastChats",
  // Memory is about the USER, not the filesystem — it belongs in both spaces.
  "Remember",
]);

/** Sandbox-scoped tools make no sense in Code (it has the real filesystem). */
const SANDBOX_ONLY_NAMES = new Set([
  "RunPython",
  "RunCommand",
  "SandboxList",
  "SandboxRead",
  "SandboxWrite",
  "SandboxEdit",
]);

/** Browser Use tools — Code-only, and only when the user enabled Browser Use. */
const BROWSER_TOOL_NAMES = new Set([
  "BrowserNavigate",
  "BrowserReadPage",
  "BrowserClick",
  "BrowserType",
  "BrowserScroll",
  "BrowserScreenshot",
]);
import {
  callMcpTool,
  connectorServerNames,
  ensureConnected,
  getMcpTools,
  hasMcpServers,
  isMcpToolName,
} from "../mcp/manager.js";
import type { LLMTool } from "../llm/adapter.js";
import {
  createParentAssistantMessage,
  createToolUseContext,
  getAppState,
  initVendorRuntime,
  setVendorPermissionMode,
} from "./vendor-context.js";

// ─── Permission modes ─────────────────────────────────────────────────────

/** The 5 UI permission levels. Map to the vendor PermissionMode the tools'
 * checkPermissions() run against — 'auto' has no vendor equivalent (needs the
 * Anthropic classifier we can't run), so it uses 'default' + a local heuristic. */
export type UiPermissionMode =
  "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";

export type PermissionAsk = {
  toolName: string;
  description: string;
  detail?: string;
};
export type PermissionDecision = "allow" | "allow-once" | "deny";
export type RequestPermission = (
  ask: PermissionAsk,
) => Promise<PermissionDecision>;

const VENDOR_MODE_FOR: Record<
  UiPermissionMode,
  "default" | "acceptEdits" | "plan" | "bypassPermissions"
> = {
  default: "default",
  acceptEdits: "acceptEdits",
  plan: "plan",
  auto: "default",
  bypassPermissions: "bypassPermissions",
};

// Tools "Auto" mode runs without asking (read/search + file mutations). Shell
// tools and anything else still prompt.
const AUTO_ALLOW_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "MultiEdit",
  "TodoWrite",
]);

// Per-session "Allow always" grants (keyed by sessionId:toolName) so a tool the
// user approved with "Allow always" won't prompt again this session.
const sessionAllowAlways = new Set<string>();

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

function describeAsk(
  tool: Tool,
  input: Record<string, unknown>,
): { description: string; detail?: string } {
  const str = (k: string): string | undefined =>
    typeof input[k] === "string" ? (input[k] as string) : undefined;
  const name = tool.name;
  if (name === "Bash" || name === "PowerShell") {
    return { description: `Run a ${name} command`, detail: str("command") };
  }
  const path = str("file_path") ?? str("path");
  if (name === "Write")
    return {
      description: `Create or overwrite ${path ? baseName(path) : "a file"}`,
      detail: path,
    };
  if (name === "Edit" || name === "MultiEdit")
    return {
      description: `Edit ${path ? baseName(path) : "a file"}`,
      detail: path,
    };
  if (name === "Read")
    return {
      description: `Read ${path ? baseName(path) : "a file"}`,
      detail: path,
    };
  const first =
    str("command") ?? str("pattern") ?? str("query") ?? str("url") ?? path;
  return { description: `Run ${name}`, detail: first };
}

type GateResult =
  | { behavior: "allow"; input: Record<string, unknown> }
  | { behavior: "deny"; message: string };

async function gatePermission(args: {
  tool: Tool;
  input: Record<string, unknown>;
  context: ToolUseContext;
  permissionMode: UiPermissionMode;
  requestPermission?: RequestPermission;
  sessionId: string;
}): Promise<GateResult> {
  const { tool, input, context, permissionMode, requestPermission, sessionId } =
    args;

  if (permissionMode === "bypassPermissions")
    return { behavior: "allow", input };

  // Plan mode: only read-only tools may run until the user approves the plan.
  if (permissionMode === "plan") {
    if (tool.isReadOnly(input)) return { behavior: "allow", input };
    return {
      behavior: "deny",
      message: `Plan mode is active — ${tool.name} is blocked. Present the plan and let the user switch modes before making changes.`,
    };
  }

  const allowKey = `${sessionId}:${tool.name}`;
  if (sessionAllowAlways.has(allowKey)) return { behavior: "allow", input };

  const perm = await tool.checkPermissions(input, context);
  if (perm.behavior === "deny") {
    return { behavior: "deny", message: `Permission denied: ${perm.message}` };
  }
  const nextInput = (perm.behavior === "allow" && perm.updatedInput) || input;
  if (perm.behavior === "allow") return { behavior: "allow", input: nextInput };

  // perm.behavior is 'ask' (or 'passthrough') — needs a decision.
  if (permissionMode === "auto") {
    if (tool.isReadOnly(input) || AUTO_ALLOW_TOOLS.has(tool.name)) {
      return { behavior: "allow", input: nextInput };
    }
  }

  if (!requestPermission) {
    return {
      behavior: "deny",
      message: `${tool.name} needs permission but no prompt channel is available.`,
    };
  }
  const { description, detail } = describeAsk(tool, input);
  const decision = await requestPermission({
    toolName: tool.userFacingName(input) || tool.name,
    description,
    detail,
  });
  if (decision === "deny") {
    return {
      behavior: "deny",
      message: `The user declined to run ${tool.name}.`,
    };
  }
  if (decision === "allow") sessionAllowAlways.add(allowKey);
  return { behavior: "allow", input: nextInput };
}

/** Clear a session's "Allow always" grants (on New session / reset). */
export function clearSessionGrants(sessionId: string): void {
  for (const key of sessionAllowAlways) {
    if (key.startsWith(`${sessionId}:`)) sessionAllowAlways.delete(key);
  }
  // Connector actions keep their own per-session grants — same lifetime.
  void import("../connectors/lib/permissions.js")
    .then((m) => m.clearConnectorSessionGrants(sessionId))
    .catch(() => {});
}

// ─── Toolset ────────────────────────────────────────────────────────────

let cachedTools: Tools | null = null;
let cachedForWorkspace: string | null = null;

export function getVendorTools(): Tools {
  const ws = initVendorRuntime();
  if (ws !== cachedForWorkspace) {
    // Workspace switch: tool enablement and prompt content (cwd, git) change.
    cachedTools = null;
    apiToolsCache.clear();
    cachedForWorkspace = ws;
  }
  if (cachedTools) return cachedTools;
  // Without a POSIX shell the vendor Bash tool errors on every call — drop
  // it so the model goes straight to PowerShell. (ensurePosixShell also
  // exports SHELL when git-bash exists, which makes Bash actually WORK.)
  const posixShell = ensurePosixShell();
  cachedTools = ALL_TOOLS.filter(
    (t) => t.isEnabled() && (posixShell !== null || t.name !== "Bash"),
  );
  return cachedTools;
}

/** Every tool the app can advertise, enablement aside. The source of truth for
 * both getVendorTools() (filtered by isEnabled) and prompt seeding (unfiltered,
 * so a disabled tool still materialises its editable prompt file). */
const ALL_TOOLS = [
  BashTool,
  PowerShellTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  TodoWriteTool,
  InlineSkillTool,
  AskUserQuestionTool,
  ToolSearchTool,
  LSPTool,
  AgentTaskTool,
  SearchPastChatsTool,
  WebFetchTool,
  WebSearchTool,
  RunPythonTool,
  RunCommandTool,
  ListMcpResourcesTool,
  ReadMcpResourceTool,
  SandboxListTool,
  SandboxReadTool,
  SandboxWriteTool,
  SandboxEditTool,
  BrowserNavigateTool,
  BrowserReadPageTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserScrollTool,
  BrowserScreenshotTool,
  ComputerTool,
  ...CONNECTOR_TOOLS,
  CreateRoutineTool,
  RememberTool,
] as unknown as Tool[];

/** Every tool, for prompt seeding — see seedTunablePrompts(). */
export function getAllToolsForSeeding(): Tool[] {
  return ALL_TOOLS;
}

/** The options object a tool's prompt() reads. Built once for seeding. */
export async function toolPromptOptions(): Promise<Record<string, unknown>> {
  initVendorRuntime();
  return {
    getToolPermissionContext: async () => getAppState().toolPermissionContext,
    tools: ALL_TOOLS,
    agents: [],
    sandboxEngine: getSandboxConfig().engine,
  };
}

/** Reset cached tools (workspace switch changes isEnabled outcomes). */
export function resetVendorTools(): void {
  cachedTools = null;
  apiToolsCache.clear();
}

/**
 * Space-filtered toolset. Home is FULLY isolated from the machine: only the
 * sandboxed subset exists there (RunPython/TodoWrite/Skill/WebFetch/WebSearch).
 * Code gets everything except RunPython (it has real shells). Used for BOTH
 * the API tool list and the system prompt, so the model never even hears
 * about Bash/FileEdit while in Home.
 */
function activeModelSeesImages(): boolean {
  const active = getProviderManager().getActive();
  return active?.modalities
    ? active.modalities.includes("image")
    : /anthropic\.com/i.test(active?.baseURL ?? "") ||
        active?.kind === "openrouter";
}

/**
 * Whether a tool may be advertised AND executed in a space. Browser Use and
 * Computer Use work in BOTH Home and Code when the user enabled them (Computer
 * Use also needs a multimodal model — it reads screenshots). Everything else
 * follows the space: Home = the sandbox subset only (no MCP, no shell/fs);
 * Code = everything except the sandbox-scoped tools.
 */
export function isSpaceToolAllowed(
  name: string,
  space?: string,
  sessionId?: string,
): boolean {
  if (name === "RunPython" || name === "RunCommand") {
    if (space !== "home") return false;
    // Don't gate on live Podman readiness — the tools provision/repair Podman
    // lazily and report errors, so hiding them on a transient wedge (which is
    // common: the WSL2 machine idles) would silently strip Home's ability to
    // run code. RunCommand needs the Podman engine; RunPython works on any.
    // Engine is per-chat (override) when a sessionId is known, else the global
    // default (system-prompt build path has no session).
    const engine = sessionId ? getSessionEngine(sessionId) : getSandboxConfig().engine;
    return engine === "docker" || name === "RunPython";
  }
  // Connectors work in BOTH spaces. Home's isolation is about the user's
  // machine — its files and shells — not about the network: WebFetch and
  // WebSearch have always lived there. A connector only ever reaches the one
  // remote service the user signed in to, so it doesn't widen that boundary.
  // Each is advertised only once an account for its protocol exists — an empty
  // Mail tool is pure schema tax and invites the model to call it and fail.
  if (CONNECTOR_TOOL_NAMES.has(name)) return connectorToolHasAccounts(name);
  // Routines exist for both spaces, so the tool does too. It's still gated by
  // the permission prompt, and it refuses outright inside an unattended run.
  if (name === "CreateRoutine") return true;
  if (name === "SearchPastChats") return getMemoryConfig().searchChats;
  // MCP resources are Code-only (Home has no MCP) and only worth advertising
  // when the user actually has connectors configured.
  if (name === "ListMcpResources" || name === "ReadMcpResource")
    return space !== "home" && hasMcpServers();
  // ToolSearch (opt-in) reveals deferred MCP tools; Code-only, and only useful
  // when there are connectors whose tools can be deferred.
  if (name === "ToolSearch")
    return space !== "home" && getToolSearchConfig().enabled && hasMcpServers();
  // LSP (opt-in) needs the real workspace + installed language servers; Code-only.
  if (name === "LSP") return space !== "home" && getLspConfig().enabled;
  if (BROWSER_TOOL_NAMES.has(name)) return getBrowserConfig().enabled;
  if (name === "Computer")
    return getComputerConfig().enabled && activeModelSeesImages();
  if (space === "home") return HOME_TOOL_NAMES.has(name);
  return !SANDBOX_ONLY_NAMES.has(name);
}

export function getVendorToolsForSpace(space?: string, sessionId?: string): Tools {
  return getVendorTools().filter((t) => isSpaceToolAllowed(t.name, space, sessionId));
}

// ─── API schema conversion (adapter-facing) ─────────────────────────────

const apiToolsCache = new Map<string, LLMTool[]>();

// (declared before getVendorTools uses it at runtime — module-level const
// hoisting via TDZ is satisfied because getVendorTools runs post-init)

export async function getVendorApiTools(
  space?: string,
  sessionId?: string,
  /** When set (non-empty), restrict MCP tools to these server names — used by a
   * routine to scope its toolset to its declared connectors. */
  allowedMcpServers?: string[],
): Promise<LLMTool[]> {
  const tools = getVendorToolsForSpace(space, sessionId);
  // The RunPython description is engine-specific, so the same tool-name set can
  // yield different text per chat — key the cache by the resolved engine too.
  const sandboxEngine = sessionId
    ? getSessionEngine(sessionId)
    : getSandboxConfig().engine;
  const cacheKey = `${sandboxEngine}::${tools.map((t) => t.name).join(",")}`;
  let base = apiToolsCache.get(cacheKey);
  if (!base) {
    const promptOptions = {
      getToolPermissionContext: async () => getAppState().toolPermissionContext,
      tools,
      agents: [],
      // Threaded into RunPython.prompt() so its guidance matches this chat.
      sandboxEngine,
    };
    base = await Promise.all(
      tools.map(async (tool) => {
        const schema = zodToJsonSchema(
          tool.inputSchema,
        ) as LLMTool["input_schema"];
        return {
          name: tool.name,
          // Lean mode drops worked examples and keeps every rule (measured:
          // TodoWrite 9114 → 3288 chars, no NEVER/IMPORTANT line lost).
          description: leanToolDescription(await tool.prompt(promptOptions)),
          input_schema: {
            type: "object" as const,
            properties: schema.properties ?? {},
            ...(schema.required ? { required: schema.required } : {}),
          },
        };
      }),
    );
    apiToolsCache.set(cacheKey, base);
  }

  // Routine scoping for the connector TOOLS: a routine that declares ["gmail"]
  // gets Mail and not Telegram. Filtering here (not in the cached build) keeps
  // one cache entry serving every routine. MCP-backed connectors are scoped by
  // server name below instead.
  if (allowedMcpServers && allowedMcpServers.length > 0) {
    const allowedTools = connectorToolNames(allowedMcpServers);
    base = base.filter(
      (t) => !CONNECTOR_TOOL_NAMES.has(t.name) || allowedTools.has(t.name),
    );
  }

  // Append live MCP tools. Not cached with the vendor tools — connections
  // (and thus the tool list) change as servers connect/disconnect.
  try {
    await ensureConnected();
    // ToolSearch (opt-in): defer MCP tools — advertise only the ones the model
    // has revealed via ToolSearch this session, so the standing schema stays
    // small. When disabled, behave exactly as before (advertise all).
    const deferMcp = getToolSearchConfig().enabled;
    const revealed = deferMcp ? getRevealedTools(sessionId ?? "default") : null;
    const allow =
      allowedMcpServers && allowedMcpServers.length > 0
        ? new Set(allowedMcpServers)
        : null;
    // Home may use MCP, but only the servers a CONNECTOR supplies: those talk
    // to one signed-in service. A hand-written server is arbitrary — it could
    // be a filesystem or shell server, and that is the machine, which is
    // exactly what Home's isolation exists to keep out.
    const spaceAllowed = space === "home" ? connectorServerNames() : null;
    const mcpTools = getMcpTools()
      .filter((t) => !revealed || revealed.has(t.fullName))
      .filter((t) => !allow || allow.has(t.serverName))
      .filter((t) => !spaceAllowed || spaceAllowed.has(t.serverName))
      .map((t) => ({
        name: t.fullName,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    if (mcpTools.length) return [...base, ...mcpTools];
  } catch {
    // MCP is best-effort — never block the toolset on a server failure.
  }
  return base;
}

// ─── Execution ──────────────────────────────────────────────────────────

function flattenToolResultContent(
  content: ToolResultBlockParam["content"],
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return "[image attached]";
      return JSON.stringify(block);
    })
    .join("\n");
}

export interface VendorToolResult {
  content: string;
  isError: boolean;
  /** Optional image to show the MODEL in the tool result (Computer Use
   * screenshots). Base64, no data: prefix. */
  image?: { base64: string; mediaType: string };
}

/** The tool.call() canUseTool hook — gating already happened in gatePermission
 * (which routes asks to the UI), so this simply confirms the pre-approved run. */
const canUseTool = async (
  _tool: unknown,
  input: Record<string, unknown>,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }> => ({
  behavior: "allow",
  updatedInput: input,
});

export async function executeVendorTool(opts: {
  sessionId: string;
  toolUseID: string;
  name: string;
  input: Record<string, unknown>;
  model: string;
  permissionMode?: UiPermissionMode;
  requestPermission?: RequestPermission;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  /** Structured sub-agent progress (Task tool → nested agent card). */
  onSubAgentEvent?: (update: SubAgentUpdate) => void;
  /** Workspace ("home" | "code"). Home HARD-BLOCKS non-sandbox tools. */
  space?: string;
  /** Round-trips a structured question to the user (AskUserQuestion tool). */
  askUser?: AskUserFn;
  /** Nobody is watching (a routine firing) — distinct from bypassPermissions,
   * which a user enables while sitting right there. */
  unattended?: boolean;
  /** Connector action ids the routine's creator granted for unattended use. */
  connectorGrants?: string[];
}): Promise<VendorToolResult> {
  const {
    sessionId,
    toolUseID,
    name,
    input,
    model,
    permissionMode = "default",
    requestPermission,
    signal,
    onProgress,
    onSubAgentEvent,
    space,
    askUser,
    unattended,
    connectorGrants,
  } = opts;
  initVendorRuntime();

  // Isolation gate, enforced at EXECUTION time (not just advertisement). MCP is
  // handled below; anything the space disallows (Home's sandbox subset, or a
  // disabled Browser/Computer tool) is refused even if the model names it from
  // memory. Browser/Computer Use, when enabled, ARE allowed in both spaces.
  const mcp = isMcpToolName(name);
  if (!mcp && !isSpaceToolAllowed(name, space, sessionId)) {
    return {
      content:
        `Tool "${name}" is not available here. In Home, use RunPython / the ` +
        `Sandbox* tools for files and computation; Browser Use and Computer ` +
        `Use must be enabled in Settings → Automation.`,
      isError: true,
    };
  }
  // Home may use MCP, but only servers a connector supplies — those talk to one
  // signed-in service. A hand-written server is arbitrary (it could be a
  // filesystem or shell server), so it stays Code-only, enforced here and not
  // just by advertisement: the model can name a tool it saw in an earlier chat.
  if (mcp && space === "home") {
    const server = name.split("__")[1] ?? "";
    if (!connectorServerNames().has(server)) {
      return {
        content:
          `The MCP server "${server}" isn't available in Home — only connectors are. ` +
          `Add it as a connector in Settings, or switch to Code.`,
        isError: true,
      };
    }
  }

  // MCP tools (mcp__<server>__<tool>) are served by the connection manager,
  // not the vendor tool pipeline. Connector-supplied servers gate through the
  // connector permission engine ("mcp.use" — overridable per account in
  // Settings); hand-written servers keep the plain mode-aware ask.
  if (isMcpToolName(name)) {
    const server = name.split("__")[1] ?? "";
    const { listAccounts, resolveAccount } = await import(
      "../connectors/index.js"
    );
    const row = listAccounts().find((a) => a.enabled && a.presetId === server);
    const acct = row ? resolveAccount(row.id) : null;
    if (acct) {
      const { gateConnectorAction } = await import(
        "../connectors/lib/permissions.js"
      );
      const r = await gateConnectorAction(
        acct,
        "mcp.use",
        {
          summary: `${acct.service.name}: run ${name.split("__")[2] ?? "tool"}`,
          detail: JSON.stringify(input).slice(0, 300),
        },
        { sessionId, permissionMode, requestPermission, unattended, connectorGrants },
      );
      if (!r.ok) return { content: r.message, isError: true };
    } else if (
      permissionMode !== "bypassPermissions" &&
      permissionMode !== "auto" &&
      requestPermission
    ) {
      const decision = await requestPermission({
        toolName: name,
        description: `Run MCP tool ${name}`,
        detail: JSON.stringify(input).slice(0, 300),
      });
      if (decision === "deny") {
        return { content: `Permission denied: ${name}`, isError: true };
      }
    }
    return callMcpTool(name, input);
  }

  // Reading an image runs a heavy native (sharp) resize the model often can't
  // even use. For a model without image input it's pointless — and that path
  // has hung the tool call — so short-circuit with a note instead of reading
  // and resizing. Vision-capable models fall through to the real read.
  if (
    name === "Read" &&
    typeof input.file_path === "string" &&
    /\.(png|jpe?g|gif|webp|bmp|tiff?|avif)$/i.test(input.file_path) &&
    !activeModelSeesImages()
  ) {
    return {
      content:
        `[Image file: ${input.file_path}. The active model has no image input, ` +
        `so its contents aren't shown. Switch to a vision-capable model to ` +
        `view images.]`,
      isError: false,
    };
  }

  // Point the vendor tools' checkPermissions() at the selected mode.
  setVendorPermissionMode(VENDOR_MODE_FOR[permissionMode]);
  const tools = getVendorTools();
  const tool = findToolByName(tools, name);
  if (!tool) {
    return { content: `Unknown tool: ${name}`, isError: true };
  }

  const context: ToolUseContext = createToolUseContext({
    sessionId,
    tools,
    model,
    signal,
  });
  (context as { toolUseId?: string }).toolUseId = toolUseID;
  // Custom tools (e.g. RunPython) read the sessionId off the context.
  (context as { sessionId?: string }).sessionId = sessionId;
  // Skill copies its bundle into the sandbox only in Home — needs the space.
  (context as { space?: string }).space = space;
  // CreateRoutine refuses to run with nobody watching. This is deliberately NOT
  // permissionMode: "Skip all approvals" is also bypassPermissions, and that
  // user is sitting right there — keying off the mode refused them their own
  // routine.
  (context as { unattended?: boolean }).unattended = unattended === true;
  // The connector permission engine (per-action allow/ask/deny) reads these
  // off the context inside the connector tools' call().
  (context as { permissionMode?: string }).permissionMode = permissionMode;
  (context as { requestPermission?: RequestPermission }).requestPermission =
    requestPermission;
  (context as { connectorGrants?: string[] }).connectorGrants = connectorGrants;
  // AskUserQuestion round-trips a question to the renderer via this callback.
  (context as { askUser?: AskUserFn }).askUser = askUser;
  if (onProgress)
    (context as Record<string, unknown>)._subAgentOnProgress = onProgress;
  if (onSubAgentEvent)
    (context as Record<string, unknown>)._subAgentEmit = onSubAgentEvent;

  try {
    // 1. Schema parse (defaults, coercions, strictness) — the query engine
    //    does this before validateInput.
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        content: `InputValidationError: ${parsed.error.message}`,
        isError: true,
      };
    }
    const toolInput = parsed.data as Record<string, unknown>;

    // 2. Tool-specific validation.
    if (tool.validateInput) {
      const validation = await tool.validateInput(toolInput, context);
      if (!validation.result) {
        return { content: `Error: ${validation.message}`, isError: true };
      }
    }

    // 3. Permission gate — mode-aware; routes 'ask' decisions to the UI.
    const gate = await gatePermission({
      tool,
      input: toolInput,
      context,
      permissionMode,
      requestPermission,
      sessionId,
    });
    if (gate.behavior === "deny") {
      return { content: gate.message, isError: true };
    }
    const finalInput = gate.input;

    // 4. Execute.
    const parentMessage = createParentAssistantMessage(
      model,
      toolUseID,
      tool.name,
      finalInput,
    );
    const result = await tool.call(
      finalInput,
      context,
      canUseTool as never,
      parentMessage,
      undefined,
    );

    // 5. Serialize the result the way the API layer would.
    const block = tool.mapToolResultToToolResultBlockParam(
      result.data,
      toolUseID,
    );
    // A tool may attach an image for the model to SEE (Computer Use
    // screenshots) via imageBase64/imageMediaType on its result data.
    const data = result.data as {
      imageBase64?: string;
      imageMediaType?: string;
    };
    const image =
      data && typeof data.imageBase64 === "string"
        ? {
            base64: data.imageBase64,
            mediaType: data.imageMediaType || "image/png",
          }
        : undefined;
    return {
      content: flattenToolResultContent(block.content),
      isError: block.is_error === true,
      image,
    };
  } catch (err) {
    if (signal?.aborted) {
      return { content: "Tool execution aborted", isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${message}`, isError: true };
  }
}
