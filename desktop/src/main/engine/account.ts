/**
 * Who the user is to Anthropic: nobody.
 *
 * The engine asks this in twenty-three places — is there an OAuth token, is
 * this a Max subscriber, what rate-limit tier, is a Bedrock or Vertex proxy
 * configured — and every answer shaped a feature: which commands appear, which
 * models are offered, whether a gate opens. Upstream those answers came from
 * a 1700-line auth module holding claude.ai OAuth tokens, keychain access, an
 * API-key resolver with six sources, 401 refresh handling and AWS credential
 * rotation.
 *
 * This app has no Anthropic account and does not want one. It talks to the
 * provider the user configured, with the user's own key, through
 * src/main/provider and src/main/llm. So every predicate here answers the same
 * way it already did in practice — there was never a token to find — and the
 * whole apparatus behind them goes.
 *
 * The one that is not simply false is isUsing3PServices: it reads env vars
 * that say "route Anthropic calls through Bedrock/Vertex/Foundry". Kept
 * faithful, because someone setting those means it.
 */

export type SubscriptionType = "pro" | "max" | "team" | "enterprise";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

/** No Anthropic-hosted auth: this app carries the user's own provider key. */
export function isAnthropicAuthEnabled(): boolean {
  return false;
}

export function getClaudeAIOAuthTokens(): OAuthTokens | null {
  return null;
}

export function getAnthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY || null;
}

export function getSubscriptionType(): SubscriptionType | null {
  return null;
}
export function isClaudeAISubscriber(): boolean {
  return false;
}
export function isProSubscriber(): boolean {
  return false;
}
export function isMaxSubscriber(): boolean {
  return false;
}
export function isTeamSubscriber(): boolean {
  return false;
}
export function isTeamPremiumSubscriber(): boolean {
  return false;
}
export function getRateLimitTier(): string | null {
  return null;
}
export function hasProfileScope(): boolean {
  return false;
}

/** Whether Anthropic calls are being routed through a cloud provider's
 *  gateway. Faithful: the env vars are the whole answer upstream too. */
export function isUsing3PServices(): boolean {
  const on = (v: string | undefined): boolean =>
    !!v && v !== "0" && v !== "false";
  return (
    on(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    on(process.env.CLAUDE_CODE_USE_VERTEX) ||
    on(process.env.CLAUDE_CODE_USE_FOUNDRY)
  );
}

/** Token refresh and 401 recovery: nothing to refresh, nothing to recover. */
export function checkAndRefreshOAuthTokenIfNeeded(
  _retryCount = 0,
  _force = false,
): boolean {
  return false;
}

export function handleOAuth401Error(
  _failedAccessToken: string,
): Promise<boolean> {
  return Promise.resolve(false);
}

/** Shaped so the Bedrock route still typechecks against it; always absent,
 *  because rotating AWS credentials for Anthropic-via-Bedrock is not a thing
 *  this app does. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export async function refreshAndGetAwsCredentials(): Promise<AwsCredentials | null> {
  return null;
}
