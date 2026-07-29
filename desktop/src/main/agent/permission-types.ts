/**
 * Permission vocabulary, in a leaf module.
 *
 * These types used to live in vendor-tools.ts, which imports the whole vendor
 * toolset — so permission-policies.ts could not use them without a cycle.
 * vendor-tools.ts re-exports them, since that is where the rest of the app
 * has always imported them from.
 */

/** The 5 UI permission levels. Map to the vendor PermissionMode the tools'
 * checkPermissions() run against — 'auto' has no vendor equivalent (needs the
 * Anthropic classifier we can't run), so it uses 'default' + a local pipeline. */
export type UiPermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "bypassPermissions";

export type PermissionAsk = {
  toolName: string;
  description: string;
  detail?: string;
};

export type PermissionDecision = "allow" | "allow-once" | "deny";

export type RequestPermission = (
  ask: PermissionAsk,
) => Promise<PermissionDecision>;
