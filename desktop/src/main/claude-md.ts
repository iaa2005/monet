/**
 * CLAUDE.md loader — reads project instructions on workspace change.
 * Used by both main and renderer processes.
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

export function loadClaudeMd(workspacePath: string): string | null {
  const paths = [
    join(workspacePath, 'CLAUDE.md'),
    join(workspacePath, '.claude', 'CLAUDE.md'),
    join(workspacePath, '.agents', 'CLAUDE.md'),
  ]

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
