/**
 * Wave B of emptying src/vendor: everything we actually run.
 *
 * Two kinds of destination, and the difference is the whole point.
 *
 * Where the leak has a subject our app already owns, it joins that subject:
 * MCP goes to src/main/mcp, the LSP client to src/main/lsp, plugins and
 * settings and secure storage get the folders they deserve, the skill loader
 * joins src/main/skills, the memory directory joins src/main/memory, the
 * computer-use bindings join src/main/computer.
 *
 * What is left is the agent engine itself — the query loop, the tool
 * contract, permissions, hooks, the message plumbing and four hundred
 * utilities that only exist to serve them. That is one cyclic component; it
 * does not decompose by wishing, and scattering it across a dozen folders
 * would only hide that. It becomes src/main/engine, a sibling of the
 * src/main/agent adapter that drives it. The name says what it is: not
 * "vendor", not "leaked" — the engine, ours now, with its debt recorded per
 * file in typecheck-debt.json.
 *
 * [vendor prefix, destination under src/] — longest prefix wins.
 */
export const PLAN = [
  // ── Subjects the app already owns ─────────────────────────────────────
  ["services/mcp", "main/mcp/protocol"],
  ["services/lsp", "main/lsp"],
  ["tools/LSPTool", "main/lsp/tool"],
  ["skills", "main/skills/loader"],
  ["services/skillSearch", "main/skills/search"],
  ["memdir", "main/memory/dir"],
  ["utils/memory", "main/memory/engine"],
  ["utils/plugins", "main/plugins"],
  ["plugins", "main/plugins/builtin"],
  ["utils/settings", "main/settings"],
  ["utils/secureStorage", "main/secure-storage"],
  ["utils/computerUse", "main/computer/native"],
  ["utils/model", "main/llm/model"],

  // ── The engine ────────────────────────────────────────────────────────
  ["tools", "main/engine/tools"],
  ["Tool.ts", "main/engine"],
  ["tools.ts", "main/engine"],
  ["Task.ts", "main/engine"],
  ["query", "main/engine/query"],
  ["query.ts", "main/engine"],
  ["services/compact", "main/engine/compact"],
  ["services/teamMemorySync", "main/engine/swarm"],
  ["utils/swarm", "main/engine/swarm"],
  ["services", "main/engine/services"],
  ["utils/permissions", "main/engine/permissions"],
  ["utils/hooks", "main/engine/hooks"],
  ["utils/hooks.ts", "main/engine/hooks"],
  ["hooks", "main/engine/hooks/react"],
  ["utils/bash", "main/engine/shell/bash"],
  ["utils/shell", "main/engine/shell"],
  ["utils/task", "main/engine/tasks"],
  ["tasks", "main/engine/tasks"],
  ["tasks.ts", "main/engine"],
  ["utils/tasks.ts", "main/engine/tasks"],
  ["state", "main/engine/state"],
  ["bootstrap", "main/engine/state"],
  ["constants", "main/engine/constants"],
  ["types", "main/engine/types"],
  ["context", "main/engine/context"],
  ["context.ts", "main/engine"],
  ["cost-tracker.ts", "main/engine"],
  ["projectOnboardingState.ts", "main/engine"],
  ["schemas", "main/engine/schemas"],
  ["jobs", "main/engine/jobs"],
  ["outputStyles", "main/engine/output-styles"],
  ["coordinator", "main/engine/coordinator"],
  ["buddy", "main/engine/buddy"],
  ["proactive", "main/engine/proactive"],
  ["voice", "main/engine/voice"],
  ["utils", "main/engine/utils"],
];
