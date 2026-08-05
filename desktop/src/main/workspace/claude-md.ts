/**
 * Project memory loader — reads project instructions on workspace change.
 *
 * MONET.md is ours and wins when both exist; CLAUDE.md is read because it is
 * the ecosystem's format and most repos carry that one. Interop, not legacy.
 * The name list lives in shared/brand.ts with every other branded name.
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { DOT_DIR, MEMORY_FILENAMES } from '@shared/brand.js'

export function loadClaudeMd(workspacePath: string): string | null {
  const paths = MEMORY_FILENAMES.flatMap((name) => [
    join(workspacePath, name),
    join(workspacePath, DOT_DIR, name),
    join(workspacePath, '.claude', name),
    join(workspacePath, '.agents', name),
  ])

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf-8')
      } catch {
        continue
      }
    }
  }

  return null
}
