/**
 * Reconstructed stand-in for the build-generated SDK types (the leak ships
 * only an empty JS shim). ModelUsage is faithful — bootstrap/state.ts sums
 * its numeric fields; the rest are loose aliases used in type positions only.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number
}

export type HookEvent = string
export type HookInput = any
export type HookJSONOutput = any
export type ExitReason = string
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
export type PermissionResult = any
export type SDKMessage = any
export type SDKUserMessage = any
export type SDKAssistantMessage = any
export type SDKAssistantMessageError = any
export type SDKResultMessage = any
export type SDKResultSuccess = any
export type SDKSessionInfo = any
export type SDKStatus = any
