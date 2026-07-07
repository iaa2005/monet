import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/stores/chatStore'
import type { ElectronAPI } from '@/types/electron'

export function MessageInput(): JSX.Element {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { addUserMessage, addAssistantMessage, handleLLMEvent, setError, isStreaming } = useChatStore()

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
    }
  }, [input])

  const handleSend = async (): Promise<void> => {
    const text = input.trim()
    if (!text || isStreaming) return

    setInput('')

    // Add user message
    const userMsg = addUserMessage(text)

    // Add empty assistant message for streaming
    addAssistantMessage()

    try {
      const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI

      // Set up token listener
      const unsubscribe = api.chat.onToken(handleLLMEvent)

      await api.chat.send({
        model: '', // will be filled by main from active provider
        system: 'You are a helpful AI assistant.',
        messages: [
          { role: 'user', content: userMsg.content },
        ],
        max_tokens: 4096,
      })

      unsubscribe()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send message'
      setError(message)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleAbort = async (): Promise<void> => {
    const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI
    await api.chat.abort()
  }

  return (
    <div className="border-t bg-background p-4">
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything... (Enter to send, Shift+Enter for new line)"
          className="min-h-[40px] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          rows={1}
          disabled={isStreaming}
        />
        {isStreaming ? (
          <Button variant="destructive" onClick={handleAbort}>
            Stop
          </Button>
        ) : (
          <Button onClick={handleSend} disabled={!input.trim()}>
            Send
          </Button>
        )}
      </div>
    </div>
  )
}
