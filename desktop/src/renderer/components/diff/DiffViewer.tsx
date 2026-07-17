/**
 * Diff Viewer — the Changes review panel. Each file renders through the shared
 * DiffView (line numbers, +/- markers, folded "N unmodified lines" context,
 * syntax highlighting) with an Accept / Reject header on top.
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { DiffView } from '@/components/chat/DiffView'
import { diffStats, langFromPath } from '@/components/chat/diff-core'

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

const PREVIEW_FILE_COUNT = 50

function FileDiff({ file, onAccept, onReject }: {
  file: DiffFile
  onAccept: () => void
  onReject: () => void
}): JSX.Element {
  const stats = diffStats(file.oldContent, file.newContent)

  return (
    <div className="glass-panel mb-4 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm font-medium">{file.path}</span>
          <span className="shrink-0 font-mono text-xs">
            <span className="text-diff-add-text">+{stats.added}</span>
            {' '}
            <span className="text-diff-remove-text">-{stats.removed}</span>
          </span>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="outline" onClick={onAccept}>
            Accept
          </Button>
          <Button size="sm" variant="outline" onClick={onReject}>
            Reject
          </Button>
        </div>
      </div>

      <DiffView
        oldText={file.oldContent}
        newText={file.newContent}
        language={langFromPath(file.path)}
        maxHeight={480}
      />
    </div>
  )
}

export function DiffViewer({ files, onAccept, onReject, onAcceptAll, onRejectAll }: DiffViewerProps): JSX.Element {
  const [showAll, setShowAll] = useState(false)

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>No changes to review</p>
      </div>
    )
  }

  const tooMany = files.length > PREVIEW_FILE_COUNT
  const visible = tooMany && !showAll ? files.slice(0, PREVIEW_FILE_COUNT) : files

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
        {tooMany && !showAll && (
          <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-muted-foreground">
            Showing first {PREVIEW_FILE_COUNT} of {files.length} files.
            {' '}
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="font-medium text-link hover:underline"
            >
              Show all {files.length} files
            </button>
          </div>
        )}
        {visible.map((file, i) => (
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
