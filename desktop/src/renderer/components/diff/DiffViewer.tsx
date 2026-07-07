/**
 * Diff Viewer — unified diff with syntax highlighting.
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface DiffFile {
  path: string
  oldContent: string
  newContent: string
}

interface DiffViewerProps {
  files: DiffFile[]
  onAccept: (file: DiffFile) => void
  onReject: (file: DiffFile) => void
  onAcceptAll: () => void
  onRejectAll: () => void
}

interface DiffLine {
  type: 'unchanged' | 'added' | 'removed'
  content: string
  oldLine?: number
  newLine?: number
}

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const result: DiffLine[] = []

  // Simple line-by-line diff (LCS would be better but this works for MVP)
  let oi = 0, ni = 0

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      result.push({ type: 'unchanged', content: oldLines[oi], oldLine: oi + 1, newLine: ni + 1 })
      oi++; ni++
    } else {
      // Try to find alignment
      let found = false
      // Look ahead for matching line
      for (let look = 1; look < 20 && oi + look < oldLines.length; look++) {
        if (oldLines[oi + look] === newLines[ni]) {
          // Lines were removed
          for (let r = 0; r < look; r++) {
            result.push({ type: 'removed', content: oldLines[oi + r], oldLine: oi + r + 1 })
          }
          oi += look
          found = true
          break
        }
      }
      if (!found) {
        for (let look = 1; look < 20 && ni + look < newLines.length; look++) {
          if (oldLines[oi] === newLines[ni + look]) {
            // Lines were added
            for (let a = 0; a < look; a++) {
              result.push({ type: 'added', content: newLines[ni + a], newLine: ni + a + 1 })
            }
            ni += look
            found = true
            break
          }
        }
      }
      if (!found) {
        // Replace: one line changed
        if (oi < oldLines.length) {
          result.push({ type: 'removed', content: oldLines[oi], oldLine: oi + 1 })
          oi++
        }
        if (ni < newLines.length) {
          result.push({ type: 'added', content: newLines[ni], newLine: ni + 1 })
          ni++
        }
      }
    }
  }

  return result
}

function FileDiff({ file, onAccept, onReject }: {
  file: DiffFile
  onAccept: () => void
  onReject: () => void
}): JSX.Element {
  const diff = computeDiff(file.oldContent, file.newContent)
  const stats = {
    added: diff.filter(l => l.type === 'added').length,
    removed: diff.filter(l => l.type === 'removed').length,
  }

  return (
    <div className="mb-4 rounded-lg border">
      <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{file.path}</span>
          <span className="text-xs text-muted-foreground">
            <span className="text-green-500">+{stats.added}</span>
            {' '}
            <span className="text-red-500">-{stats.removed}</span>
          </span>
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={onAccept}>
            Accept
          </Button>
          <Button size="sm" variant="outline" onClick={onReject}>
            Reject
          </Button>
        </div>
      </div>

      <div className="overflow-auto max-h-96 font-mono text-xs">
        {diff.map((line, i) => (
          <div
            key={i}
            className={cn(
              'flex px-2 py-0.5',
              line.type === 'added' && 'bg-green-500/10 text-green-600',
              line.type === 'removed' && 'bg-red-500/10 text-red-600',
            )}
          >
            <span className="w-10 shrink-0 select-none text-right text-muted-foreground mr-3">
              {line.oldLine || ' '}
            </span>
            <span className="w-10 shrink-0 select-none text-right text-muted-foreground mr-3">
              {line.newLine || ' '}
            </span>
            <span className="mr-1 select-none">
              {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
            </span>
            <span className="whitespace-pre">{line.content || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function DiffViewer({ files, onAccept, onReject, onAcceptAll, onRejectAll }: DiffViewerProps): JSX.Element {
  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>No changes to review</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          Changes ({files.length} file{files.length !== 1 ? 's' : ''})
        </h2>
        <div className="flex gap-2">
          <Button size="sm" onClick={onAcceptAll}>Accept All</Button>
          <Button size="sm" variant="outline" onClick={onRejectAll}>Reject All</Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {files.map((file, i) => (
          <FileDiff
            key={i}
            file={file}
            onAccept={() => onAccept(file)}
            onReject={() => onReject(file)}
          />
        ))}
      </div>
    </div>
  )
}
