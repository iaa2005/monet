/**
 * Permission decisions as an ordered pipeline of named policies.
 *
 * This used to be one linear function where the order of `if` statements WAS
 * the policy, undocumented. That shape is how the auto-mode bug happened:
 * Edit and Write were allowed by tool NAME, and since a path outside the
 * workspace only produces "ask" (never "deny"), auto mode would write anywhere
 * on disk. The fix at the time was correct but invisible — a reader could not
 * see that a path check existed, let alone where.
 *
 * Kimi Code models the same problem as ~17 single-purpose policy files, and
 * that is what is copied here: each stage has a name, a comment saying what it
 * decides and why it sits where it does, and no knowledge of its neighbours.
 * The first stage with an opinion wins; `null` means "no opinion, keep going".
 *
 * Adding a rule is adding a stage at a considered position, rather than
 * finding the right line in a 60-line conditional.
 */

import type { Tool, ToolUseContext } from "@vendor/Tool.js";
import { isSensitivePath } from "./secret-filter.js";
import type { RequestPermission, UiPermissionMode } from "./permission-types.js";

export interface PolicyContext {
  tool: Tool;
  input: Record<string, unknown>;
  context: ToolUseContext;
  permissionMode: UiPermissionMode;
  requestPermission?: RequestPermission;
  sessionId: string;
  /** Per-session "Allow always" grants, keyed `sessionId:key`. */
  grants: Set<string>;
}

export type PolicyDecision =
  | { behavior: "allow"; input: Record<string, unknown> }
  | { behavior: "deny"; message: string }
  | null;

export interface PermissionPolicy {
  /** Stable id — appears in the decision trace. */
  readonly name: string;
  decide(ctx: PolicyContext): Promise<PolicyDecision> | PolicyDecision;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Every path-shaped argument of a call, across the tools that take one. */
export function pathArgs(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["file_path", "path", "notebook_path", "filePath"]) {
    const v = input[key];
    if (typeof v === "string" && v) out.push(v);
  }
  // MultiEdit-style batches.
  const edits = input.edits;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      const v = (e as { file_path?: unknown })?.file_path;
      if (typeof v === "string" && v) out.push(v);
    }
  }
  return out;
}

function toolTouchesSensitiveFile(input: Record<string, unknown>): string | null {
  for (const p of pathArgs(input)) if (isSensitivePath(p)) return p;
  return null;
}

// ─── Policies, in the order they run ────────────────────────────────────

/**
 * "Skip all approvals" means what it says: the user turned the gate off for
 * this session, and every later stage is moot. First, so nothing below can
 * accidentally re-introduce a prompt into an explicitly unattended run.
 */
const bypassModeApprove: PermissionPolicy = {
  name: "bypass-mode-approve",
  decide: ({ permissionMode, input }) =>
    permissionMode === "bypassPermissions" ? { behavior: "allow", input } : null,
};

/**
 * Plan mode is a promise that nothing changes until the plan is approved, so
 * it outranks every allow below — including the user's own "Allow always"
 * grants, which were given for a different mode.
 */
const planModeGuard: PermissionPolicy = {
  name: "plan-mode-guard",
  decide: ({ permissionMode, tool, input }) => {
    if (permissionMode !== "plan") return null;
    if (tool.isReadOnly(input)) return { behavior: "allow", input };
    return {
      behavior: "deny",
      message: `Plan mode is active — ${tool.name} is blocked. Present the plan and let the user switch modes before making changes.`,
    };
  },
};

/**
 * A path holding secrets is worth one question even when the mode says not to
 * ask, because the modes were set for ordinary work.
 *
 * This is the stage that did not exist before. `Read` is read-only, so auto
 * mode allowed it outright — the agent could open `.env` or `id_rsa` and put
 * the contents in the transcript without a word. Kimi draws the same line:
 * its YOLO mode still asks about sensitive files and plan exits.
 *
 * Sits above session-approval-history on purpose: "always allow Read", given
 * while reading source files, should not silently extend to credentials. The
 * grant it takes is per-PATH, so approving one secret does not approve the
 * next.
 */
const sensitiveFileAsk: PermissionPolicy = {
  name: "sensitive-file-ask",
  async decide(ctx): Promise<PolicyDecision> {
    const { input, grants, sessionId, requestPermission, tool } = ctx;
    const hit = toolTouchesSensitiveFile(input);
    if (!hit) return null;

    const key = `${sessionId}:sensitive:${hit}`;
    if (grants.has(key)) return null; // approved earlier this session

    if (!requestPermission) {
      return {
        behavior: "deny",
        message:
          `${tool.name} targets ${hit}, which may hold credentials, and there is ` +
          `nobody to ask. Run this with a person present, or move the value out of that file.`,
      };
    }
    const decision = await requestPermission({
      toolName: tool.userFacingName(input) || tool.name,
      description: `${tool.name} wants to access a file that may hold credentials`,
      detail: hit,
    });
    if (decision === "deny") {
      return { behavior: "deny", message: `The user declined access to ${hit}.` };
    }
    if (decision === "allow") grants.add(key);
    // Approved — but say nothing, so the stages below still apply their own
    // rules to the call. An approved secret read is not an approved anything.
    return null;
  },
};

/** A tool the user already accepted with "Allow always" this session. */
const sessionApprovalHistory: PermissionPolicy = {
  name: "session-approval-history",
  decide: ({ grants, sessionId, tool, input }) =>
    grants.has(`${sessionId}:${tool.name}`) ? { behavior: "allow", input } : null,
};

/**
 * The tool's own rules (the vendor's checkPermissions): user-configured allow
 * and deny lists, workspace scoping, read-before-edit. A "deny" here is final;
 * an "allow" may rewrite the input. Anything else means "ask", which is not an
 * answer, so the pipeline continues.
 */
const toolOwnRules: PermissionPolicy = {
  name: "tool-own-rules",
  async decide({ tool, input, context }): Promise<PolicyDecision> {
    const perm = await tool.checkPermissions(input, context);
    if (perm.behavior === "deny")
      return { behavior: "deny", message: `Permission denied: ${perm.message}` };
    if (perm.behavior === "allow")
      return {
        behavior: "allow",
        input: (perm.updatedInput as Record<string, unknown>) ?? input,
      };
    return null;
  },
};

/**
 * Auto mode, part 1: tools that cannot damage anything.
 *
 * Read-only calls, plus a short list of tools that only touch this session's
 * own bookkeeping or exist to involve the user. Mirrors the vendor's SAFE_YOLO
 * allowlist, narrowed to what this app ships.
 */
export const AUTO_ALLOW_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "LSP",
  "ToolSearch",
  "ListMcpResources",
  "ReadMcpResource",
  "TodoWrite",
  "AskUserQuestion",
]);

const autoModeApprove: PermissionPolicy = {
  name: "auto-mode-approve",
  decide: ({ permissionMode, tool, input }) => {
    if (permissionMode !== "auto") return null;
    if (tool.isReadOnly(input) || AUTO_ALLOW_TOOLS.has(tool.name))
      return { behavior: "allow", input };
    return null;
  },
};

/**
 * Auto mode, part 2: writes, but only where acceptEdits would allow them.
 *
 * Re-asks the tool's own check as if the user had chosen acceptEdits. That
 * mode allows writes inside the working directory and only there, so an edit
 * in the workspace runs silently while one outside it still prompts — and the
 * path scoping comes from the vendor's rules rather than from a name list.
 * Allowing Edit and Write BY NAME here is exactly the bug this file exists to
 * make impossible.
 *
 * The mode is passed through a per-call shim rather than by flipping the
 * global vendor mode: tools run concurrently, and a global flip across an
 * await would leak acceptEdits into an unrelated check.
 */
const autoModeAcceptEdits: PermissionPolicy = {
  name: "auto-mode-accept-edits",
  async decide({ permissionMode, tool, input, context }): Promise<PolicyDecision> {
    if (permissionMode !== "auto") return null;
    try {
      const state = context.getAppState();
      const perm = state.toolPermissionContext;
      if (perm.mode === "acceptEdits") return null; // already covered above
      const scoped = {
        ...context,
        getAppState: () => ({
          ...state,
          toolPermissionContext: { ...perm, mode: "acceptEdits" as const },
        }),
      } as ToolUseContext;
      const r = await tool.checkPermissions(input, scoped);
      if (r.behavior !== "allow") return null;
      return {
        behavior: "allow",
        input: (r.updatedInput as Record<string, unknown>) ?? input,
      };
    } catch {
      // A failing probe must never widen permissions.
      return null;
    }
  },
};

/** Nobody above had an opinion: ask the user, or refuse if there is no one. */
const fallbackAsk: PermissionPolicy = {
  name: "fallback-ask",
  async decide(ctx): Promise<PolicyDecision> {
    const { tool, input, requestPermission, grants, sessionId } = ctx;
    if (!requestPermission)
      return {
        behavior: "deny",
        message: `${tool.name} needs permission but no prompt channel is available.`,
      };
    const { description, detail } = describeAsk(tool, input);
    const decision = await requestPermission({
      toolName: tool.userFacingName(input) || tool.name,
      description,
      detail,
    });
    if (decision === "deny")
      return { behavior: "deny", message: `The user declined to run ${tool.name}.` };
    if (decision === "allow") grants.add(`${sessionId}:${tool.name}`);
    return { behavior: "allow", input };
  },
};

/**
 * The pipeline. Order is the policy — read it top to bottom.
 */
export const PERMISSION_POLICIES: readonly PermissionPolicy[] = [
  bypassModeApprove,
  planModeGuard,
  sensitiveFileAsk,
  sessionApprovalHistory,
  toolOwnRules,
  autoModeApprove,
  autoModeAcceptEdits,
  fallbackAsk,
];

/**
 * Run the pipeline. Returns the winning decision and the policy that made it,
 * so a surprising outcome can be traced to one named stage.
 */
export async function decidePermission(
  ctx: PolicyContext,
  policies: readonly PermissionPolicy[] = PERMISSION_POLICIES,
): Promise<{
  decision: Exclude<PolicyDecision, null>;
  decidedBy: string;
}> {
  let input = ctx.input;
  for (const policy of policies) {
    const d = await policy.decide({ ...ctx, input });
    if (!d) continue;
    // An allow may rewrite the input; carry that forward so a later stage
    // (and the executor) sees the rewritten call, not the original.
    if (d.behavior === "allow") input = d.input;
    return { decision: { ...d, ...(d.behavior === "allow" && { input }) }, decidedBy: policy.name };
  }
  // Unreachable while fallbackAsk is last, but a pipeline is data and someone
  // will edit it: refusing beats running an unapproved tool.
  return {
    decision: {
      behavior: "deny",
      message: `No permission policy decided on ${ctx.tool.name}.`,
    },
    decidedBy: "no-policy",
  };
}

// ─── Prompt copy ────────────────────────────────────────────────────────

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

/** What the approval dialog says about a call. */
export function describeAsk(
  tool: Tool,
  input: Record<string, unknown>,
): { description: string; detail?: string } {
  const str = (k: string): string | undefined =>
    typeof input[k] === "string" ? (input[k] as string) : undefined;
  const name = tool.name;
  if (name === "Bash" || name === "PowerShell")
    return { description: `Run a ${name} command`, detail: str("command") };
  const path = str("file_path") ?? str("path");
  if (name === "Write")
    return {
      description: `Create or overwrite ${path ? baseName(path) : "a file"}`,
      detail: path,
    };
  if (name === "Edit" || name === "MultiEdit")
    return { description: `Edit ${path ? baseName(path) : "a file"}`, detail: path };
  if (name === "Read")
    return { description: `Read ${path ? baseName(path) : "a file"}`, detail: path };
  const first =
    str("command") ?? str("pattern") ?? str("query") ?? str("url") ?? path;
  return { description: `Run ${name}`, detail: first };
}
