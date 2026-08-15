import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Portal } from '@/components/ui/portal'
import type { PermissionRequest as PermRequest, PermissionDecision } from '@/types/electron'

interface PermissionDialogProps {
  request: PermRequest
  onDecision: (decision: PermissionDecision) => void
  /** How many more are waiting behind this one. */
  pendingCount?: number
}

export function PermissionDialog({
  request,
  onDecision,
  pendingCount = 0,
}: PermissionDialogProps): JSX.Element {
  const [visible, setVisible] = useState(true)

  const handleDecision = (decision: PermissionDecision): void => {
    setVisible(false)
    onDecision(decision)
  }

  if (!visible) return <></>

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border bg-background p-6 shadow-lg">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-lg font-semibold">Permission Required</h3>
          {pendingCount > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {pendingCount} more waiting
            </span>
          )}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          <strong>{request.toolName}</strong> wants to:
        </p>
        <p className="mt-1 text-sm">{request.description}</p>
        {request.detail && (
          <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted p-2 text-xs">
            {request.detail}
          </pre>
        )}

        <div className="mt-4 flex gap-2">
          <Button
            variant="default"
            onClick={() => handleDecision('allow-once')}
            className="flex-1"
          >
            Allow Once
          </Button>
          <Button
            variant="outline"
            onClick={() => handleDecision('allow')}
            className="flex-1"
          >
            Allow Always
          </Button>
          <Button
            variant="destructive"
            onClick={() => handleDecision('deny')}
          >
            Deny
          </Button>
        </div>
      </div>
    </div>
  )
  return <Portal>{dialog}</Portal>
}
