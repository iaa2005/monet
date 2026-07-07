/**
 * Shim for bootstrap/state.ts — Desktop Agent.
 *
 * Original is 1329 lines with OTel metrics, session management, etc.
 * This shim provides the minimum exports needed for vendor/leaked code
 * to compile and run in Electron context.
 *
 * DO NOT add real OTel / GrowthBook dependencies here — those are
 * injected by the main process at runtime.
 */

import { randomUUID } from 'node:crypto'
import type { SessionId } from '../types/ids.js'
import type { ModelUsage } from '../entrypoints/agentSdkTypes.js'
import type { ModelSetting } from '../utils/model/model.js'

// ─── Session ────────────────────────────────────────────────────────────

let sessionId: SessionId = randomUUID() as SessionId
let parentSessionId: SessionId | undefined
let originalCwd = process.cwd()
let projectRoot = process.cwd()
let cwdState = process.cwd()

export function getSessionId(): SessionId {
  return sessionId
}

export function setSessionId(id: SessionId): void {
  sessionId = id
}

export function getParentSessionId(): SessionId | undefined {
  return parentSessionId
}

export function regenerateSessionId(): SessionId {
  parentSessionId = sessionId
  sessionId = randomUUID() as SessionId
  return sessionId
}

export function switchSession(id: SessionId, _projectDir?: string | null): void {
  sessionId = id
}

export function getOriginalCwd(): string {
  return originalCwd
}

export function setOriginalCwd(cwd: string): void {
  originalCwd = cwd
}

export function getProjectRoot(): string {
  return projectRoot
}

export function setProjectRoot(cwd: string): void {
  projectRoot = cwd
}

export function getCwdState(): string {
  return cwdState
}

export function setCwdState(cwd: string): void {
  cwdState = cwd
}

// ─── Session flags ──────────────────────────────────────────────────────

let isNonInteractive = false
let isRemoteMode = false
let devChannels = false
let sessionPersistenceDisabled = false
let mainLoopModelOverride: string | undefined

export function getIsNonInteractiveSession(): boolean {
  return isNonInteractive
}

export function setIsNonInteractiveSession(v: boolean): void {
  isNonInteractive = v
}

export function setIsRemoteMode(v: boolean): void {
  isRemoteMode = v
}

export function getIsRemoteMode(): boolean {
  return isRemoteMode
}

export function hasDevChannels(): boolean {
  return devChannels
}

export function isSessionPersistenceDisabled(): boolean {
  return sessionPersistenceDisabled
}

export function setMainLoopModelOverride(model: string | undefined): void {
  mainLoopModelOverride = model
}

// ─── Cost tracking ──────────────────────────────────────────────────────

let totalCostUSD = 0
let totalAPIDuration = 0
const modelUsage: Record<string, ModelUsage> = {}

export function getTotalCostUSD(): number {
  return totalCostUSD
}

export function addToTotalCostState(cost: number, usage: ModelUsage, model: string): void {
  totalCostUSD += cost
  modelUsage[model] = usage
}

export function resetCostState(): void {
  totalCostUSD = 0
  totalAPIDuration = 0
}

export function getModelUsage(): Record<string, ModelUsage> {
  return modelUsage
}

export function getTotalAPIDuration(): number {
  return totalAPIDuration
}

// ─── Token counters ─────────────────────────────────────────────────────

let totalInputTokens = 0
let totalOutputTokens = 0

export function getTotalInputTokens(): number {
  return totalInputTokens
}

export function getTotalOutputTokens(): number {
  return totalOutputTokens
}

// ─── Token / cost counter accessors (used by prompts + QueryEngine) ─────

export function getTokenCounter(): {
  getTotalInputTokens: () => number
  getTotalOutputTokens: () => number
} {
  return {
    getTotalInputTokens: () => totalInputTokens,
    getTotalOutputTokens: () => totalOutputTokens,
  }
}

export function getCostCounter(): {
  getTotalCostUSD: () => number
} {
  return {
    getTotalCostUSD: () => totalCostUSD,
  }
}

// ─── Session counter ────────────────────────────────────────────────────

let sessionCounter = 0

export function getSessionCounter(): number {
  return sessionCounter
}

// ─── CLAUDE.md directories ──────────────────────────────────────────────

let additionalDirectoriesForClaudeMd: string[] = []

export function setAdditionalDirectoriesForClaudeMd(dirs: string[]): void {
  additionalDirectoriesForClaudeMd = dirs
}

// ─── Teleported session info ────────────────────────────────────────────

let teleportedSessionInfo: Record<string, unknown> | undefined

export function setTeleportedSessionInfo(info: Record<string, unknown> | undefined): void {
  teleportedSessionInfo = info
}

// ─── Meter (OTel stub) ──────────────────────────────────────────────────

let meter: unknown = null

export function setMeter(m: unknown): void {
  meter = m
}

// ─── Additional stubs needed by vendor imports ──────────────────────────

export function getDirectConnectServerUrl(): string | undefined {
  return undefined
}

export function getSessionProjectDir(): string | null {
  return null
}

export function addToTotalDurationState(_duration: number, _withoutRetries: number): void {}

export function getTotalDuration(): number {
  return 0
}

export function getTotalToolDuration(): number {
  return 0
}

export function getSdkBetas(): string[] {
  return []
}

export function getInvokedSkillsForAgent(_agentId: string): string[] {
  return []
}

export function clearInvokedSkillsForAgent(_agentId: string): void {}

export function getSdkAgentProgressSummariesEnabled(): boolean {
  return false
}

export function setPromptId(_id: string): void {}

export function getMainThreadAgentType(): string {
  return 'default'
}

export function markPostCompaction(): void {}

export function isAutoMemoryEnabled(): boolean {
  return false
}

// ─── Signal (pub/sub stub) ──────────────────────────────────────────────

export const onSessionSwitch = {
  subscribe: (_fn: (id: SessionId) => void) => {
    return { unsubscribe: () => {} }
  },
}
