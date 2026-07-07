import { useState, useCallback, useEffect, lazy, Suspense } from "react";
import { ProviderSettings } from "@/components/providers/ProviderSettings";
import { ChatView, usePermissionHandler } from "@/components/chat/ChatView";
import { SessionList } from "@/components/SessionList";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { SkillsPanel } from "@/components/SkillsPanel";
import { DiffViewer, type DiffFile } from "@/components/diff/DiffViewer";
import { FileTree } from "@/components/FileTree";
import { useChatStore } from "@/stores/chatStore";
import { useSkillsStore } from "@/stores/skillsStore";
import { Button } from "@/components/ui/button";
import type { ChatMessage } from "@/types/chat";
import type { ElectronAPI } from "@/types/electron";

// Lazy-load heavy components
const Terminal = lazy(() =>
  import("@/components/Terminal").then((m) => ({ default: m.Terminal })),
);

type Tab = "chat" | "changes" | "files" | "terminal" | "skills" | "providers";

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("chat");
  const [currentSessionId, setCurrentSessionId] = useState<
    string | undefined
  >();
  const [showSessions, setShowSessions] = useState(true);
  const [diffs, setDiffs] = useState<DiffFile[]>([]);

  const chatStore = useChatStore();
  const activeSkills = useSkillsStore((s) =>
    s.skills.filter((sk) => sk.enabled),
  );

  usePermissionHandler();

  useEffect(() => {
    const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI;
    api.workspace.get().then((ws) => {
      document.title = `Claude Code Desktop — ${ws.split(/[/\\]/).pop() || ws}`;
    });
  }, []);

  useEffect(() => {
    const skillNames = activeSkills.map((s) => s.name).join(", ");
    (window as unknown as Record<string, unknown>).__activeSkills =
      activeSkills;
    (window as unknown as Record<string, unknown>).__activeSkillNames =
      skillNames;
  }, [activeSkills]);

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
        const api = (window as unknown as { electronAPI: ElectronAPI })
          .electronAPI;
        await api.sessions.deleteById(id);
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

  const tabs: { id: Tab; label: string }[] = [
    { id: "chat", label: "Chat" },
    {
      id: "changes",
      label: `Changes${diffs.length ? ` (${diffs.length})` : ""}`,
    },
    { id: "files", label: "Files" },
    { id: "terminal", label: "Terminal" },
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
        <div className="flex gap-1 flex-wrap">
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
          {tab === "files" && <FileTree />}
          {tab === "terminal" && (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  Loading terminal...
                </div>
              }
            >
              <Terminal />
            </Suspense>
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
