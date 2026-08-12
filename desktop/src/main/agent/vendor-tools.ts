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
import { globWithSecretFilter, grepWithSecretFilter } from "./secret-filter.js";
import { ReadMediaFileTool } from "./media-tool.js";
import { decidePermission } from "./permission-policies.js";
import type {
  RequestPermission,
  UiPermissionMode,
} from "./permission-types.js";
import type { Tool, Tools, ToolUseContext } from "../engine/Tool.js";
import { findToolByName } from "../engine/Tool.js";
import { BashTool } from "../engine/tools/BashTool/BashTool.jsx";
import { FileEditTool } from "../engine/tools/FileEditTool/FileEditTool.js";
import { FileReadTool } from "../engine/tools/FileReadTool/FileReadTool.js";
import { FileWriteTool } from "../engine/tools/FileWriteTool/FileWriteTool.js";
import { GlobTool } from "../engine/tools/GlobTool/GlobTool.js";
import { GrepTool } from "../engine/tools/GrepTool/GrepTool.js";
import { PowerShellTool } from "../engine/tools/PowerShellTool/PowerShellTool.jsx";
import { TodoWriteTool } from "../engine/tools/TodoWriteTool/TodoWriteTool.js";
import { zodToJsonSchema } from "../engine/utils/zodToJsonSchema.js";
import { InlineSkillTool } from "./skill-tool.js";
import { AgentTaskTool } from "./agent-tool.js";
import { AgentSwarmTool } from "./swarm-tool.js";
import { UpdateGoalTool } from "./goal/tool.js";
import { SearchPastChatsTool } from "./memory-tools.js";
import { getMemoryConfig } from "../memory/store.js";
import {
  ObsidianAttachTool,
  ObsidianEditTool,
  ObsidianMoveTool,
  ObsidianReadTool,
  ObsidianSearchTool,
  ObsidianWriteTool,
} from "../obsidian/tools.js";
import { hasEnabledVaults } from "../obsidian/vaults.js";
import { OCRScanTool } from "../ocr/tools.js";
import { hasOcrModel } from "../ocr/ready.js";
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
import { renderDeferredDirective } from "./deferred-inventory.js";
import { getService as getConnectorService } from "../connectors/services/registry.js";
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
import { CreateSkillTool } from "./create-skill-tool.js";
import {
  EnterPlanModeTool,
  ExitPlanModeTool,
  UpdatePlanTool,
} from "./plan-tool.js";
import { SendMessageTool, TeamListTool } from "./team-tools.js";
import { NotebookEditTool } from "../engine/tools/NotebookEditTool/NotebookEditTool.js";
import { effectiveMode } from "./session-mode.js";
import type { AskPlanApprovalFn } from "../ipc/plan.js";
import {
  SandboxFileGlobTool,
  SandboxFileReadTool,
  SandboxFileWriteTool,
  SandboxFileEditTool,
} from "./sandbox-file-tools.js";
import { sessionSpace } from "./session-space.js";
import { ensurePosixShell } from "./shell-env.js";
import {
  BrowserEvalTool,
  BrowserLogsTool,
  BrowserNavigateTool,
  BrowserReadPageTool,
  BrowserInputTool,
  BrowserScreenshotTool,
  BrowserTabsTool,
} from "./browser-tools.js";
import { DevServerTool } from "./dev-server-tool.js";
import { ServeSandboxTool } from "./serve-sandbox-tool.js";
import { getBrowserConfig } from "../browser/config.js";
import { currentPageUrl } from "../browser/page.js";
import { ComputerTool } from "./computer-tools.js";
import { getComputerConfig } from "../computer/config.js";
import { getProviderManager } from "../provider/manager.js";
import { activeModelAccepts } from "./model-modalities.js";

import { HOME_TOOL_NAMES, SANDBOX_ONLY_NAMES, spaceAllows } from "./space-tools.js";

/** Browser Use tools — Code-only, and only when the user enabled Browser Use. */
const BROWSER_TOOL_NAMES = new Set([
  "BrowserNavigate",
  "BrowserReadPage",
  "BrowserInput",
  "BrowserScreenshot",
  "BrowserLogs",
  "BrowserEval",
  "BrowserTabs",
  // Same gate: a tool that spawns processes belongs with the browser it exists
  // to serve, not on by default.
  "DevServer",
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
import { hooksAvailable, runPreToolHooks, runPostToolHooks } from "./tool-hooks.js";

// ─── Permission modes ─────────────────────────────────────────────────────

export type {
  UiPermissionMode,
  PermissionAsk,
  PermissionDecision,
  RequestPermission,
} from "./permission-types.js";

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

// The permission gate lives in permission-policies.ts as an ordered list of
// named stages. It used to be a single 60-line conditional here, where the
// order of the `if`s WAS the policy and nothing said so.

// Per-session grants ("Allow always", and per-path approval of a sensitive
// file), keyed `sessionId:...` — see permission-policies.ts.
const sessionAllowAlways = new Set<string>();

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
  const browserCfg = getBrowserConfig();
  const { decision } = await decidePermission({
    ...args,
    grants: sessionAllowAlways,
    // Read here, where reaching Electron is already the norm, and handed to a
    // policy file that stays decidable on its own.
    browser: {
      approval: browserCfg.approval,
      allowedOrigins: browserCfg.allowedOrigins,
      currentUrl: args.tool.name.startsWith("Browser") ? currentPageUrl() : null,
    },
  });
  return decision;
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
  ReadMediaFileTool,
  // Wrapped so `.env` and private keys never reach the model through a
  // search — see secret-filter.ts.
  globWithSecretFilter(GlobTool as unknown as Tool),
  grepWithSecretFilter(GrepTool as unknown as Tool),
  TodoWriteTool,
  InlineSkillTool,
  AskUserQuestionTool,
  ToolSearchTool,
  LSPTool,
  AgentTaskTool,
  AgentSwarmTool,
  UpdateGoalTool,
  SearchPastChatsTool,
  // The user's Obsidian vaults — advertised only while one is enabled.
  ObsidianSearchTool,
  ObsidianReadTool,
  ObsidianWriteTool,
  ObsidianEditTool,
  ObsidianAttachTool,
  ObsidianMoveTool,
  OCRScanTool,
  WebFetchTool,
  WebSearchTool,
  RunPythonTool,
  RunCommandTool,
  ListMcpResourcesTool,
  ReadMcpResourceTool,
  BrowserNavigateTool,
  BrowserReadPageTool,
  BrowserScreenshotTool,
  BrowserLogsTool,
  BrowserEvalTool,
  BrowserTabsTool,
  DevServerTool,
  ServeSandboxTool,
  ComputerTool,
  ...CONNECTOR_TOOLS,
  CreateRoutineTool,
  RememberTool,
  // Writes a new skill into the user's skills folder — the counterpart of the
  // Skill tool, which runs one.
  CreateSkillTool,
  EnterPlanModeTool,
  ExitPlanModeTool,
  UpdatePlanTool,
  SendMessageTool,
  TeamListTool,
  NotebookEditTool,
] as unknown as Tool[];

/** Every tool, for prompt seeding — see seedTunablePrompts(). */
export function getAllToolsForSeeding(): Tool[] {
  // The sandbox file tools are not in ALL_TOOLS — they share their names with
  // the disk ones — but their prompts are editable too, so seeding sees both.
  return [...ALL_TOOLS, ...SANDBOX_FILE_TOOLS];
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
/** Whether the active model accepts a given input modality. Lives in its own
 * leaf module so the tools can ask too — this file imports them. The fallback
 * for a config with no resolved modalities reads the MODEL id, not the
 * provider's Base URL — see inferModalities(). */
export { activeModelAccepts };

function activeModelSeesImages(): boolean {
  return activeModelAccepts("image");
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
  // Serving the sandbox is Home's answer to "show me the page": it publishes
  // the chat's own folder on loopback from inside the container, so it needs
  // the Podman engine and belongs nowhere near Code (which has DevServer and
  // a real workspace).
  if (name === "ServeSandbox")
    return space === "home" && getSessionEngine(sessionId ?? "default") === "docker";
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
  // Vault tools appear only when a vault is enabled — an empty ObsidianSearch
  // is schema tax that invites a call destined to fail. Both spaces: the
  // knowledge base is the USER's, not the machine's, so Home's isolation
  // does not apply to it (same reasoning as connectors above).
  if (
    name === "ObsidianSearch" ||
    name === "ObsidianRead" ||
    name === "ObsidianWrite" ||
    name === "ObsidianEdit" ||
    name === "ObsidianAttach" ||
    name === "ObsidianMove"
  )
    return hasEnabledVaults();
  // OCR appears once a model is on disk. Offering it without one produces a
  // tool whose every call is "install a model first" — advice the tool list
  // has no business giving.
  if (name === "OCRScan") return hasOcrModel();
  // MCP RESOURCES are Code-only, and the old note here said "Home has no MCP",
  // which is wrong and is exactly what makes this confusing: Home does get MCP,
  // from CONNECTOR servers only (see spaceAllowed below, and the check at the
  // call site). What stays out of Home is a hand-written server from the config
  // file, because that can be a filesystem or shell server — the machine, which
  // is what Home isolates. Resources have no connector-only filter yet, so they
  // remain Code-only rather than being let through unfiltered.
  if (name === "ListMcpResources" || name === "ReadMcpResource")
    return space !== "home" && hasMcpServers();
  // ToolSearch (opt-in) reveals deferred MCP tools. It used to be Code-only,
  // while the deferral below applied in EVERY space — so in Home a connector's
  // MCP tools were held back with no way left to reveal them. Home does get
  // connector-backed MCP (see spaceAllowed in the tool list), so the tool
  // belongs here too; its catalog is filtered by the same rule.
  if (name === "ToolSearch")
    return getToolSearchConfig().enabled && hasMcpServers();
  // LSP (opt-in) needs the real workspace + installed language servers; Code-only.
  if (name === "LSP") return space !== "home" && getLspConfig().enabled;
  // DevServer runs a command on the HOST in the Code workspace — in Home
  // there is no workspace and it served the app's own project root instead
  // (published on every interface). Home serves its sandbox with
  // ServeSandbox; this stays where a workspace exists.
  if (name === "DevServer")
    return space !== "home" && getBrowserConfig().enabled;
  if (BROWSER_TOOL_NAMES.has(name)) return getBrowserConfig().enabled;
  if (name === "Computer")
    return getComputerConfig().enabled && activeModelSeesImages();
  return spaceAllows(name, space);
}

/**
 * Look a tool up by the name the MODEL used, for the batching planner.
 *
 * Only needs `isConcurrencySafe`. An MCP tool resolves to undefined here and
 * the planner treats that as "not safe" — those are network calls to somebody
 * else's server, and guessing on their behalf is not ours to do.
 */
export function toolConcurrencyLookup(
  space?: string,
  sessionId?: string,
): (name: string) => { name: string; isConcurrencySafe(input: unknown): boolean } | undefined {
  const tools = getVendorToolsForSpace(space, sessionId);
  return (name: string) => {
    const t = findToolByName(tools, name);
    if (!t) return undefined;
    return {
      name: t.name,
      isConcurrencySafe: (input: unknown) =>
        t.isConcurrencySafe(input as never) === true,
    };
  };
}

/**
 * Home's file tools address the chat's sandbox; Code's address the disk. They
 * carry the SAME names — Read, Write, Edit, Glob — because the model should
 * not have to know which filesystem it is on to ask for a file. Choosing
 * between them is this function's job, and it is made from the session row
 * (see sessionSpace), not from a value the renderer passed in.
 */
const SANDBOX_FILE_TOOLS = [
  SandboxFileReadTool,
  SandboxFileWriteTool,
  SandboxFileEditTool,
  SandboxFileGlobTool,
] as unknown as Tool[];

const SANDBOX_FILE_TOOL_NAMES = new Set(SANDBOX_FILE_TOOLS.map((t) => t.name));

export function getVendorToolsForSpace(space?: string, sessionId?: string): Tools {
  const resolved = sessionSpace(sessionId, space);
  const base = getVendorTools().filter((t) =>
    isSpaceToolAllowed(t.name, resolved, sessionId),
  );
  if (resolved !== "home") return base;
  // Swap, never append: two tools of one name would make the model's choice
  // ambiguous and findToolByName's arbitrary.
  return [
    ...base.filter((t) => !SANDBOX_FILE_TOOL_NAMES.has(t.name)),
    ...SANDBOX_FILE_TOOLS,
  ];
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
  // gets Mail and not Telegram. The scope is EXPLICIT: an empty array means no
  // connector tools at all — the editor lists what a routine has, and a list
  // with nothing on it that quietly meant "everything" was a trap. Undefined
  // (a normal chat) stays unrestricted. Filtering here (not in the cached
  // build) keeps one cache entry serving every routine.
  if (allowedMcpServers) {
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
    const allow = allowedMcpServers ? new Set(allowedMcpServers) : null;
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
  /** Round-trips a plan for approval (ExitPlanMode tool). */
  askPlanApproval?: AskPlanApprovalFn;
  /** Nobody is watching (a routine firing) — distinct from bypassPermissions,
   * which a user enables while sitting right there. */
  unattended?: boolean;
  /** Who is calling — the main loop stays "agent"; sub-agents pass their own
   * name so plan notes and comments carry a real byline. */
  agentLabel?: string;
  /** Connector action ids the routine's creator granted for unattended use. */
  connectorGrants?: string[];
}): Promise<VendorToolResult> {
  const {
    sessionId,
    toolUseID,
    name,
    input,
    model,
    permissionMode: requestedMode = "default",
    requestPermission,
    signal,
    onProgress,
    onSubAgentEvent,
    space,
    askUser,
    askPlanApproval,
    unattended,
    agentLabel,
    connectorGrants,
  } = opts;
  // Approving a plan flips the mode mid-turn, so the live value wins over the
  // one captured when the turn started.
  const permissionMode = effectiveMode(sessionId, requestedMode);
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
        // Per-tool id, so Settings and routine grants can be precise; the
        // blanket "mcp.use" override/grant still covers all of them.
        `mcp.use.${name.split("__")[2] ?? "tool"}`,
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
  const found = findToolByName(tools, name);
  if (!found) {
    return { content: `Unknown tool: ${name}`, isError: true };
  }
  // Narrowing is lost inside the nested invokeTool closure below; bind it once.
  const tool: Tool = found;

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
  // ExitPlanMode shows the plan and returns the user's verdict.
  (context as { askPlanApproval?: AskPlanApprovalFn }).askPlanApproval =
    askPlanApproval;
  // UpdatePlan signs plan updates with the calling agent's name.
  if (agentLabel) (context as { agentLabel?: string }).agentLabel = agentLabel;
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

    // 2b. PreToolUse hooks — before the permission gate, so a hook can block
    //     the call, rewrite its input, or decide the permission itself.
    let hookedInput = toolInput;
    let hookContext: string[] | undefined;
    const hooksOn = await hooksAvailable();
    if (hooksOn) {
      const pre = await runPreToolHooks({
        toolName: tool.name,
        toolUseID,
        input: toolInput,
        context,
        permissionMode,
        signal,
      });
      if (pre.blocked) return { content: pre.blocked, isError: true };
      if (pre.stopReason) return { content: pre.stopReason, isError: true };
      if (pre.updatedInput) hookedInput = pre.updatedInput;
      hookContext = pre.additionalContext;
      if (pre.permission === "deny")
        return {
          content: pre.permissionReason
            ? `Permission denied by hook: ${pre.permissionReason}`
            : `A PreToolUse hook denied ${tool.name}.`,
          isError: true,
        };
      // An "allow" from a hook is an explicit user-configured decision, so it
      // stands in for the prompt. "ask" falls through to the normal gate.
      if (pre.permission === "allow") {
        return await invokeTool(hookedInput, hookContext);
      }
    }

    // 3. Permission gate — mode-aware; routes 'ask' decisions to the UI.
    const gate = await gatePermission({
      tool,
      input: hookedInput,
      context,
      permissionMode,
      requestPermission,
      sessionId,
    });
    if (gate.behavior === "deny") {
      return { content: gate.message, isError: true };
    }
    const finalInput = gate.input;
    return await invokeTool(finalInput, hookContext);

    // ── Execution + PostToolUse, shared by both paths above ──
    async function invokeTool(
      callInput: Record<string, unknown>,
      extraContext: string[] | undefined,
    ): Promise<VendorToolResult> {

    // 4. Execute.
    const parentMessage = createParentAssistantMessage(
      model,
      toolUseID,
      tool.name,
      callInput,
    );
    const result = await tool.call(
      callInput,
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
    let content = flattenToolResultContent(block.content);
    let isError = block.is_error === true;

    // 6. PostToolUse hooks — may append context the model should see, or
    //    report a problem with the result (exit code 2).
    if (hooksOn) {
      const post = await runPostToolHooks({
        toolName: tool.name,
        toolUseID,
        input: callInput,
        response: result.data,
        context,
        permissionMode,
        signal,
      });
      const extras = [...(extraContext ?? []), ...(post.additionalContext ?? [])];
      if (extras.length) content = `${content}\n\n${extras.join("\n\n")}`;
      if (post.blocked) {
        content = `${content}\n\n${post.blocked}`;
        isError = true;
      }
    } else if (extraContext?.length) {
      content = `${content}\n\n${extraContext.join("\n\n")}`;
    }

    return { content, isError, image };
    }
  } catch (err) {
    if (signal?.aborted) {
      return { content: "Tool execution aborted", isError: true };
    }
    // A non-zero exit makes BashTool throw a ShellError whose .message is only
    // "Shell command failed" — the real output lives in .stdout/.stderr and the
    // exit code in .code. Taking just .message swallowed all of it, so a red
    // pytest run, a `grep` with no match, or a `diff` with differences (all
    // legitimate exit-1 commands) came back as a blank failure with nothing to
    // act on. Surface the actual output, the way the CLI does.
    const e = err as { name?: string; stdout?: unknown; stderr?: unknown; code?: unknown };
    if (e?.name === "ShellError") {
      const body = [e.stderr, e.stdout]
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .find((s) => s.length > 0);
      const code = typeof e.code === "number" ? e.code : "?";
      return {
        content: body
          ? `${body}\n\n(Exit code ${code})`
          : `Command failed with exit code ${code} (it produced no output).`,
        isError: true,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${message}`, isError: true };
  }
}

/**
 * The deferred-tool announcement for a run, or "" when nothing is held back.
 *
 * Lives here rather than beside the renderer because it has to mirror the tool
 * filtering above EXACTLY: announcing a tool this run would refuse to load is
 * worse than announcing nothing — the model would call ToolSearch, get nothing,
 * and be back to guessing. Already-revealed tools are omitted (they are in the
 * schema), and in Home only connector-backed servers are eligible at all.
 */
export function deferredToolsPending(
  space?: string,
  sessionId?: string,
): { serverName: string; fullName: string }[] {
  if (!getToolSearchConfig().enabled) return [];
  try {
    const revealed = getRevealedTools(sessionId ?? "default");
    const allowed = space === "home" ? connectorServerNames() : null;
    return getMcpTools()
      .filter((t) => !revealed.has(t.fullName))
      .filter((t) => !allowed || allowed.has(t.serverName))
      .map((t) => ({ serverName: t.serverName, fullName: t.fullName }));
  } catch {
    // Never block a run on the inventory — a missing announcement degrades to
    // the old behaviour, a thrown one loses the turn.
    return [];
  }
}

/** Label a server the way the rest of the UI does: the connector's own name
 * when one supplies it, the raw server name otherwise. */
export function deferredServerLabel(server: string): string {
  try {
    return getConnectorService(server)?.name ?? server;
  } catch {
    return server;
  }
}

export function deferredToolsDirective(
  space?: string,
  sessionId?: string,
): string {
  return renderDeferredDirective(
    deferredToolsPending(space, sessionId),
    deferredServerLabel,
  );
}
