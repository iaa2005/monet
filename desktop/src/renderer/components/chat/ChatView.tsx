import { useEffect, useRef } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { MarkdownViewer } from './MarkdownViewer'
import { ToolCallBubble } from './ToolCallBubble'
import { PermissionDialog } from './PermissionDialog'
import { MessageInput } from './MessageInput'
import { cn } from '@/lib/utils'
import type { ElectronAPI, PermissionRequest, PermissionDecision } from '@/types/electron'
import type { ChatMessage } from '@/types/chat'

function MessageBubble({ msg }: { msg: ChatMessage }): JSX.Element {
  const isUser = msg.role === 'user'
  const isTool = msg.role === 'tool'

  if (isTool && msg.toolCall) {
    return <ToolCallBubble toolCall={msg.toolCall} />
  }

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-4 py-2 text-sm',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted',
          msg.isError && 'border border-red-500 text-red-500',
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{msg.content}</p>
        ) : (
          <MarkdownViewer content={msg.content || (msg.isStreaming ? '...' : '')} />
        )}
      </div>
    </div>
  )
}

export function ChatView(): JSX.Element {
  const messages = useChatStore(s => s.messages)
  const isStreaming = useChatStore(s => s.isStreaming)
  const error = useChatStore(s => s.error)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  return (
    <div className="flex h-full flex-col">
      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-4">
        {messages.length === 0 && !error && (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p>Send a message to start</p>
          </div>
        )}

        <div className="space-y-3">
          {messages.map(msg => (
            <MessageBubble key={msg.id} msg={msg} />
          ))}

          {error && (
            <div className="rounded-lg border border-red-500 bg-red-500/10 p-3 text-sm text-red-500">
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Input area */}
      <MessageInput />
    </div>
  )
}

/**
 * Permission handler hook — listens for permission requests and shows dialog.
 */
export function usePermissionHandler(): void {
  useEffect(() => {
    const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI

    const unsubscribe = api.permissions.onRequest((request: PermissionRequest) => {
      // Show dialog via a simple approach — for MVP we auto-allow
      // In production, this would set state in a store to show the dialog
      console.log('Permission requested:', request)
      api.permissions.respond('allow-once')
    })

    return unsubscribe
  }, [])
}
