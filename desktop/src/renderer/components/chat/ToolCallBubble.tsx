import type { ToolCall } from '@/types/chat'
import { cn } from '@/lib/utils'

interface ToolCallBubbleProps {
  toolCall: ToolCall
}

const STATUS_COLORS: Record<ToolCall['status'], string> = {
  pending: 'border-yellow-500/50 bg-yellow-500/5',
  running: 'border-blue-500/50 bg-blue-500/5',
  done: 'border-green-500/50 bg-green-500/5',
  error: 'border-red-500/50 bg-red-500/5',
}

const STATUS_ICONS: Record<ToolCall['status'], string> = {
  pending: '⏳',
  running: '🔄',
  done: '✅',
  error: '❌',
}

export function ToolCallBubble({ toolCall }: ToolCallBubbleProps): JSX.Element {
  return (
    <div className={cn('rounded-lg border p-3 text-sm', STATUS_COLORS[toolCall.status])}>
      <div className="flex items-center gap-2 font-medium">
        <span>{STATUS_ICONS[toolCall.status]}</span>
        <span>{toolCall.name}</span>
      </div>
      {Object.keys(toolCall.input).length > 0 && (
        <div className="mt-1 text-xs text-muted-foreground">
          {JSON.stringify(toolCall.input, null, 2)}
        </div>
      )}
      {toolCall.output && (
        <div className="mt-2 whitespace-pre-wrap rounded bg-background/50 p-2 text-xs">
          {toolCall.output}
        </div>
      )}
    </div>
  )
}
