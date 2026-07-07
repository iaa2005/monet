/**
 * Shim for bun:bundle — feature flag system.
 *
 * Original: Bun's bundle-time dead-code elimination via `feature('FLAG')`.
 * In Electron/Vite, all features default to `false` (desktop build).
 * Individual flags can be enabled via environment variables.
 */

type FeatureFlag =
  | 'PROACTIVE'
  | 'KAIROS'
  | 'TEAMMEM'
  | 'FULLSCREEN'
  | 'BETA_HEADER'
  | (string & {})

const enabledFlags = new Set(
  (process.env.CLAUDE_CODE_FEATURES || '')
    .split(',')
    .map(f => f.trim())
    .filter(Boolean),
)

export function feature(flag: FeatureFlag): boolean {
  return enabledFlags.has(flag)
}
