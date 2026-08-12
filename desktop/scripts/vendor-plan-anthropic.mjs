/**
 * Wave A of emptying src/vendor: the quarantine.
 *
 * The rule is the one the tree itself suggests — code that serves Anthropic's
 * product and nothing of ours. Their event pipeline, their OAuth and billing,
 * their API client, their terminal front-end, their IDE and remote bridges.
 * None of it is load-bearing for Code Monet; all of it is still reachable
 * today, which is why it moves rather than gets deleted.
 *
 * src/anthropic is a holding pen, not a home. Everything in it is a candidate
 * for deletion once the last edge into it is cut, and the point of gathering
 * it under one roof is to be able to SEE those edges.
 *
 * [vendor prefix, destination under src/] — longest prefix wins.
 */
export const PLAN = [
  // ── Their service ────────────────────────────────────────────────────
  ["services/analytics", "anthropic/analytics"], // statsig, growthbook, tengu events
  ["utils/telemetry", "anthropic/analytics/telemetry"], // OTel exporters
  ["utils/telemetryAttributes.ts", "anthropic/analytics"],
  ["services/api", "anthropic/api"], // the Anthropic API client
  // Both of these have a types.ts; flattening them into one directory loses
  // a file, so each keeps its own.
  ["services/oauth", "anthropic/account/oauth"],
  ["services/policyLimits", "anthropic/account/policy-limits"],
  ["services/claudeAiLimits.ts", "anthropic/account"],
  ["services/rateLimitMessages.ts", "anthropic/account"],
  ["utils/auth.ts", "anthropic/account"],
  ["utils/billing.ts", "anthropic/account"],
  ["utils/user.ts", "anthropic/account"],

  // ── Their front-end: the terminal app we do not render ────────────────
  ["components", "anthropic/cli/components"],
  ["ink", "anthropic/cli/ink"],
  ["ink.ts", "anthropic/cli"],
  ["keybindings", "anthropic/cli/keybindings"],
  ["entrypoints", "anthropic/cli/entrypoints"],
  ["commands", "anthropic/cli/commands"],

  // ── Their integrations ────────────────────────────────────────────────
  ["bridge", "anthropic/bridge"], // Claude Code remote bridge
  ["utils/claudeInChrome", "anthropic/claude-in-chrome"],
  ["utils/teleport", "anthropic/teleport"],
  ["utils/teleport.tsx", "anthropic/teleport"],
  ["utils/ide.ts", "anthropic/ide"],
];
