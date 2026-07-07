/**
 * Shim for src/utils/crypto.js — pure re-export of node:crypto.
 *
 * Original: import { randomUUID } from 'src/utils/crypto.js'
 * which internally does platform detection (Bun vs Node vs browser).
 * In Electron main process we always use Node crypto.
 */

export { randomUUID } from 'node:crypto'

// Additional exports used by vendor code
import { createHash, randomBytes } from 'node:crypto'

export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}
