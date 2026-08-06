import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Truncate in the MIDDLE: "Very long note about tra…sformers.md".
 *
 * For file and note names the end is the informative part (the extension,
 * the distinguishing suffix), so tail-truncation — what CSS `truncate`
 * does — hides exactly what tells two similar tabs apart.
 */
export function midEllipsis(s: string, max = 24): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) * 0.6)
  const tail = max - 1 - head
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}
