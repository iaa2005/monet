import { useState, useRef, useEffect } from "react";
import { ArrowUp, Square, Mic, ChevronDown } from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import type { ElectronAPI } from "@/types/electron";

export function MessageInput(): JSX.Element {
  const [input, setInput] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const {
    addUserMessage,
    addAssistantMessage,
    handleLLMEvent,
    setError,
    isStreaming,
  } = useChatStore();

  // Auto-resize textarea
  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
    }
  }, [input])

  const send = async () => {
    const t = input.trim();
    if (!t || isStreaming) return;
    setInput("");
    addUserMessage(t);
    addAssistantMessage();
    try {
      const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI

      // Set up token listener
      const unsubscribe = api.chat.onToken(handleLLMEvent)

      await api.chat.send({
        model: "",
        system: "",
        messages: [{ role: "user", content: t }],
        max_tokens: 8192,
      });
      unsub();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  const handleAbort = async (): Promise<void> => {
    const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI
    await api.chat.abort()
  }

  return (
    <div className="border-t border-border bg-background px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        {/* Left pills */}
        <button className="btn-pill text-[11px] gap-1">
          Auto <ChevronDown className="size-2.5" />
        </button>
        <button className="btn-ghost h-7 w-7 p-0">
          <PlusIcon className="size-3.5" />
        </button>
        <button className="btn-ghost h-7 w-7 p-0">
          <Mic className="size-3.5" />
        </button>

        {/* Input */}
        <div className="flex-1 relative">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Type / for commands"
            className="input-claude min-h-[36px] resize-none"
            rows={1}
            disabled={isStreaming}
          />
        </div>

        {/* Right buttons */}
        {isStreaming ? (
          <button
            onClick={() => window.electronAPI.chat.abort()}
            className="btn-ghost h-9 w-9 p-0"
          >
            <Square className="size-4" />
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!input.trim()}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-foreground text-background hover:bg-foreground/90 disabled:opacity-30 transition-colors"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  )
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}
