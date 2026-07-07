import { useState, useCallback } from "react";
import { ProviderSettings } from "@/components/providers/ProviderSettings";
import { ChatView, usePermissionHandler } from "@/components/chat/ChatView";
import { SessionList } from "@/components/SessionList";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { useChatStore } from "@/stores/chatStore";
import { Button } from "@/components/ui/button";
import type { ChatMessage } from "@/types/chat";

type Tab = "chat" | "providers";

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("chat");
  const [currentSessionId, setCurrentSessionId] = useState<
    string | undefined
  >();
  const [showSessions, setShowSessions] = useState(true);

  const chatStore = useChatStore();

  usePermissionHandler();

  const handleSelectSession = useCallback(
    (session: { id: string; title: string; messages: ChatMessage[] }) => {
      setCurrentSessionId(session.id);
      // Replace chat store messages with session messages
      chatStore.clearMessages();
      // We'd ideally load messages one by one, but for MVP we just set the session
      useChatStore.setState({ messages: session.messages });
    },
    [chatStore],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      try {
        await window.electronAPI.sessions.deleteById(id);
        if (id === currentSessionId) {
          setCurrentSessionId(undefined);
          chatStore.clearMessages();
        }
      } catch (err) {
        console.error("Failed to delete session:", err);
      }
    },
    [currentSessionId, chatStore],
  );

  // Auto-save session when messages change
  const saveCurrentSession = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      const session =
        await window.electronAPI.sessions.getById(currentSessionId);
      if (session) {
        session.messages = chatStore.messages as unknown as never[];
        await window.electronAPI.sessions.save(session as never);
      }
    } catch (err) {
      console.error("Failed to save session:", err);
    }
  }, [currentSessionId, chatStore.messages]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSessions(!showSessions)}
            className="text-xs"
          >
            {showSessions ? "◀" : "▶"}
          </Button>
          <h1 className="text-lg font-bold">Claude Code Desktop</h1>
          <WorkspacePicker />
        </div>
        <div className="flex gap-1">
          <Button
            variant={tab === "chat" ? "default" : "outline"}
            size="sm"
            onClick={() => setTab("chat")}
          >
            Chat
          </Button>
          <Button
            variant={tab === "providers" ? "default" : "outline"}
            size="sm"
            onClick={() => setTab("providers")}
          >
            Settings
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {showSessions && (
          <div className="w-64 shrink-0">
            <SessionList
              onSelect={handleSelectSession}
              onDelete={handleDeleteSession}
              currentSessionId={currentSessionId}
            />
          </div>
        )}

        <main className="flex-1 overflow-hidden">
          {tab === "chat" && <ChatView />}
          {tab === "providers" && (
            <div className="p-6">
              <ProviderSettings />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
