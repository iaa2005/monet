/**
 * Hook bridge — runs the vendor's PreToolUse / PostToolUse hooks around this
 * app's tool executor.
 *
 * The vendor ships a full hook engine (utils/hooks.ts) that nothing in the app
 * ever called, so user-configured hooks silently did nothing. The engine's
 * generators yield AggregatedHookResult; the REPL consumes them into React
 * message state, which is useless here. These wrappers drain the generators
 * and reduce them to the few decisions the executor actually needs: block,
 * rewrite the input, pre-decide the permission, or add context for the model.
 *
 * Hook definitions come from the settings snapshot captured in
 * initVendorRuntime() — the standard Claude Code layout, so
 * `<workspace>/.claude/settings.json` and `~/.claude/settings.json` work
 * unchanged.
 */

import type { ToolUseContext } from "@vendor/Tool.js";

export interface PreToolHookOutcome {
  /** A hook blocked the call; message goes back to the model. */
  blocked?: string;
  /** A hook rewrote the tool input. */
  updatedInput?: Record<string, unknown>;
  /** A hook decided the permission outright, skipping the prompt. */
  permission?: "allow" | "deny" | "ask";
  /** Reason a hook gave for its permission decision. */
  permissionReason?: string;
  /** Extra context a hook wants the model to see. */
  additionalContext?: string[];
  /** A hook asked to stop the turn. */
  stopReason?: string;
}

/**
 * Re-read hook definitions from disk.
 *
 * Both halves are required: the settings layer caches each source, so
 * re-snapshotting without dropping that cache would just re-copy the stale
 * values. Call after the user edits .claude/settings.json — otherwise a hook
 * added while the app is running does nothing until restart.
 */
export async function reloadHooks(): Promise<void> {
  const { resetSettingsCache } = await import(
    "@vendor/utils/settings/settingsCache.js"
  );
  const { captureHooksConfigSnapshot } = await import(
    "@vendor/utils/hooks/hooksConfigSnapshot.js"
  );
  resetSettingsCache();
  captureHooksConfigSnapshot();
}

/** What is configured right now, per event — for showing the user that their
 * hooks were actually picked up. */
export async function listConfiguredHooks(): Promise<
  { event: string; matcher: string; commands: string[] }[]
> {
  try {
    const { getHooksConfigFromSnapshot } = await import(
      "@vendor/utils/hooks/hooksConfigSnapshot.js"
    );
    const snap = getHooksConfigFromSnapshot() ?? {};
    const out: { event: string; matcher: string; commands: string[] }[] = [];
    for (const [event, matchers] of Object.entries(snap)) {
      for (const m of (matchers ?? []) as {
        matcher?: string;
        hooks?: { command?: string; type?: string }[];
      }[]) {
        out.push({
          event,
          matcher: m.matcher || "*",
          commands: (m.hooks ?? []).map((h) => h.command || h.type || "?"),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** True when the engine is present and something is configured. Cheap enough
 * to call per tool call — the engine itself early-returns when no hook matches. */
export async function hooksAvailable(): Promise<boolean> {
  try {
    const { getHooksConfigFromSnapshot } = await import(
      "@vendor/utils/hooks/hooksConfigSnapshot.js"
    );
    const snap = getHooksConfigFromSnapshot();
    return !!snap && Object.keys(snap).length > 0;
  } catch {
    return false;
  }
}

export async function runPreToolHooks(args: {
  toolName: string;
  toolUseID: string;
  input: Record<string, unknown>;
  context: ToolUseContext;
  permissionMode: string;
  signal?: AbortSignal;
}): Promise<PreToolHookOutcome> {
  const out: PreToolHookOutcome = {};
  try {
    const { executePreToolHooks } = await import("@vendor/utils/hooks.js");
    for await (const r of executePreToolHooks(
      args.toolName,
      args.toolUseID,
      args.input,
      args.context,
      args.permissionMode,
      args.signal,
    )) {
      // A blocking error is the whole point of PreToolUse (exit code 2):
      // the call must not happen and the model must be told why.
      if (r.blockingError)
        out.blocked =
          typeof r.blockingError === "string"
            ? r.blockingError
            : ((r.blockingError as { blockingError?: string }).blockingError ??
              "A PreToolUse hook blocked this tool call.");
      if (r.updatedInput) out.updatedInput = { ...(out.updatedInput ?? args.input), ...r.updatedInput };
      if (r.permissionBehavior === "allow" || r.permissionBehavior === "deny" || r.permissionBehavior === "ask")
        out.permission = r.permissionBehavior;
      if (r.hookPermissionDecisionReason) out.permissionReason = r.hookPermissionDecisionReason;
      if (r.additionalContexts?.length)
        out.additionalContext = [...(out.additionalContext ?? []), ...r.additionalContexts];
      if (r.stopReason) out.stopReason = r.stopReason;
      if (r.preventContinuation && !out.stopReason)
        out.stopReason = "A PreToolUse hook stopped the turn.";
    }
  } catch (e) {
    // A broken hook must not take the tool call down with it, and must never
    // silently WIDEN permissions — on error we simply don't apply any hook
    // decision and let the normal gate run.
    console.error("[hooks] PreToolUse failed:", e);
  }
  return out;
}

export interface PostToolHookOutcome {
  /** Text a hook wants appended to what the model sees. */
  additionalContext?: string[];
  /** A hook reported a problem with the result (exit code 2). */
  blocked?: string;
  stopReason?: string;
}

export async function runPostToolHooks(args: {
  toolName: string;
  toolUseID: string;
  input: Record<string, unknown>;
  response: unknown;
  context: ToolUseContext;
  permissionMode: string;
  signal?: AbortSignal;
}): Promise<PostToolHookOutcome> {
  const out: PostToolHookOutcome = {};
  try {
    const { executePostToolHooks } = await import("@vendor/utils/hooks.js");
    for await (const r of executePostToolHooks(
      args.toolName,
      args.toolUseID,
      args.input,
      args.response,
      args.context,
      args.permissionMode,
      args.signal,
    )) {
      if (r.blockingError)
        out.blocked =
          typeof r.blockingError === "string"
            ? r.blockingError
            : ((r.blockingError as { blockingError?: string }).blockingError ??
              "A PostToolUse hook reported a problem.");
      if (r.additionalContexts?.length)
        out.additionalContext = [...(out.additionalContext ?? []), ...r.additionalContexts];
      if (r.stopReason) out.stopReason = r.stopReason;
    }
  } catch (e) {
    console.error("[hooks] PostToolUse failed:", e);
  }
  return out;
}
