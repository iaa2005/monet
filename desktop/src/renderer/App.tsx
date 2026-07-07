import { useState, useCallback } from "react";
import { ProviderSettings } from "@/components/providers/ProviderSettings";
import { ChatView, usePermissionHandler } from "@/components/chat/ChatView";
import { SessionList } from "@/components/SessionList";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { SkillsPanel } from "@/components/SkillsPanel";
import { DiffViewer, type DiffFile } from "@/components/diff/DiffViewer";
import { useChatStore } from "@/stores/chatStore";
import { Button } from "@/components/ui/button";
import type { ChatMessage } from "@/types/chat";

type Tab = "chat" | "changes" | "skills" | "providers";

// Simple in-memory diff store (will be populated by tool results)
const pendingDiffs: DiffFile[] = [];

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("chat");
  const [currentSessionId, setCurrentSessionId] = useState<
    string | undefined
  >();
  const [showSessions, setShowSessions] = useState(true);
  const [diffs, setDiffs] = useState<DiffFile[]>(pendingDiffs);

  const chatStore = useChatStore();

  usePermissionHandler();

  const handleSelectSession = useCallback(
    (session: { id: string; title: string; messages: ChatMessage[] }) => {
      setCurrentSessionId(session.id);
      chatStore.clearMessages();
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

  // Expose addDiff for tool results
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__addDiff = (
      file: DiffFile,
    ) => {
      setDiffs((prev) => [...prev, file]);
      setTab("changes");
    };
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "chat", label: "Chat" },
    {
      id: "changes",
      label: `Changes${diffs.length ? ` (${diffs.length})` : ""}`,
    },
    { id: "skills", label: "Skills" },
    { id: "providers", label: "Settings" },
  ];

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
          {tabs.map((t) => (
            <Button
              key={t.id}
              variant={tab === t.id ? "default" : "outline"}
              size="sm"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {showSessions && tab === "chat" && (
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
          {tab === "changes" && (
            <DiffViewer
              files={diffs}
              onAccept={() => setDiffs([])}
              onReject={() => setDiffs([])}
              onAcceptAll={() => setDiffs([])}
              onRejectAll={() => setDiffs([])}
            />
          )}
          {tab === "skills" && <SkillsPanel />}
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
