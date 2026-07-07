import { useState, useCallback, useEffect, lazy, Suspense } from "react";
import {
  Home,
  Code,
  FolderTree,
  Terminal as TerminalIcon,
  Sparkles,
  Settings,
  PanelLeft,
  PanelLeftClose,
  Sun,
  Moon,
  MoreHorizontal,
  Plus,
  Search,
  ChevronRight,
  ExternalLink,
  ChevronDown,
  Play,
} from "lucide-react";
import { ProviderSettings } from "@/components/providers/ProviderSettings";
import { ChatView, usePermissionHandler } from "@/components/chat/ChatView";
import { SessionList } from "@/components/SessionList";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { SkillsPanel } from "@/components/SkillsPanel";
import { DiffViewer, type DiffFile } from "@/components/diff/DiffViewer";
import { FileTree } from "@/components/FileTree";
import { useChatStore } from "@/stores/chatStore";
import type { ChatMessage } from "@/types/chat";
import type { ElectronAPI } from "@/types/electron";

const Terminal = lazy(() =>
  import("@/components/Terminal").then((m) => ({ default: m.Terminal })),
);

type View = "chat" | "changes" | "files" | "terminal" | "skills" | "providers";

function useTheme(): [() => void, "light" | "dark"] {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const s = localStorage.getItem("theme");
    if (s === "light" || s === "dark") return s;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("theme", theme);
  }, [theme]);
  return [
    useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []),
    theme,
  ];
}

export default function App(): JSX.Element {
  const [view, setView] = useState<View>("chat");
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanel, setRightPanel] = useState<"files" | null>(null);
  const [diffs] = useState<DiffFile[]>([]);
  const [toggleTheme, theme] = useTheme();
  const chatStore = useChatStore();

  usePermissionHandler();

  useEffect(() => {
    const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI;
    api.workspace.get().then((ws) => {
      document.title = `Claude Code Desktop — ${ws.split(/[/\\]/).pop() || ws}`;
    });
  }, []);

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
    <div className="flex h-screen flex-col bg-background">
      {/* ─── Header (draggable, 44px) ─── */}
      <header className="app-drag flex h-11 shrink-0 items-center border-b border-border bg-sidebar px-2">
        {/* Segmented tabs */}
        <div className="app-no-drag ml-1 flex min-w-0 items-center gap-2">
          <div className="flex h-7 items-center rounded-lg bg-muted p-0.5">
            <button
              onClick={() => setView("chat")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                view === "chat"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Home className="size-3" /> Home
            </button>
            <button
              onClick={() => setView("chat")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                view !== "chat" && view !== "providers"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Code className="size-3" /> Code
            </button>
          </div>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right actions */}
        <div className="app-no-drag ml-auto flex items-center gap-0.5">
          <button
            onClick={() => setRightPanel(rightPanel ? null : "files")}
            className={`btn-ghost h-7 w-7 p-0 ${rightPanel ? "text-foreground" : ""}`}
          >
            <FolderTree className="size-3.5" />
          </button>
          <button
            onClick={() => setView("terminal")}
            className={`btn-ghost h-7 w-7 p-0 ${view === "terminal" ? "text-foreground" : ""}`}
          >
            <TerminalIcon className="size-3.5" />
          </button>
          <button
            onClick={() => setView("changes")}
            className={`btn-ghost h-7 w-7 p-0 ${view === "changes" ? "text-foreground" : ""}`}
          >
            <Play className="size-3.5" />
          </button>
          <button
            onClick={() => setView("skills")}
            className={`btn-ghost h-7 w-7 p-0 ${view === "skills" ? "text-foreground" : ""}`}
          >
            <Sparkles className="size-3.5" />
          </button>
          <button
            onClick={() => setView("providers")}
            className={`btn-ghost h-7 w-7 p-0 ${view === "providers" ? "text-foreground" : ""}`}
          >
            <Settings className="size-3.5" />
          </button>
          <button onClick={toggleTheme} className="btn-ghost h-7 w-7 p-0">
            {theme === "dark" ? (
              <Sun className="size-3.5" />
            ) : (
              <Moon className="size-3.5" />
            )}
          </button>
        </div>
      </header>

      {/* ─── Body ─── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left sidebar */}
        {sidebarOpen && (
          <div className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
            {/* Nav */}
            <div className="flex flex-col gap-0.5 px-2 pt-3">
              <button
                onClick={async () => {
                  try {
                    const s = await window.electronAPI.sessions.create();
                    setCurrentSessionId(s.id);
                  } catch {}
                  setView("chat");
                }}
                className="sidebar-row"
              >
                <Plus className="size-4" /> New session
              </button>
              <button className="sidebar-row">
                <Sparkles className="size-4" /> Artifacts
              </button>
              <button
                onClick={() => setView("providers")}
                className={`sidebar-row ${view === "providers" ? "sidebar-row-active" : ""}`}
              >
                <Settings className="size-4" /> Settings
              </button>
            </div>

            {/* Recents */}
            <div className="flex-1 min-h-0 px-2 pt-4">
              <div className="mb-1 flex items-center justify-between px-2">
                <span className="text-[11px] font-medium text-muted-foreground">
                  Recent
                </span>
                <button className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                  <Search className="size-3" />
                </button>
              </div>
              <div className="scrollbar-thin -mx-1 overflow-y-auto px-1">
                <SessionList
                  onSelect={handleSelectSession}
                  onDelete={handleDeleteSession}
                  currentSessionId={currentSessionId}
                />
                <button
                  onClick={() => setView("skills")}
                  className="mt-2 sidebar-row"
                >
                  <Sparkles className="size-4" /> Skills
                </button>
              </div>
            </div>

            {/* Bottom tray */}
            <div className="border-t border-border px-2 py-2">
              <WorkspacePicker />
              <div className="mt-2 flex items-center gap-2 rounded-full px-2 py-1.5 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px]">
                  A
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium leading-tight">
                    User
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-tight">
                    Pro
                  </div>
                </div>
                <ChevronDown className="size-3 text-muted-foreground" />
              </div>
            </div>
          </div>
        )}

        {/* Center */}
        <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden">
          {/* Dot grid */}
          <div className="pointer-events-none absolute inset-0 bg-dot-grid" />

          <main className="relative flex flex-1 min-h-0 flex-col overflow-hidden">
            {view === "chat" && <ChatView />}
            {view === "changes" && (
              <DiffViewer
                files={diffs}
                onAccept={() => {}}
                onReject={() => {}}
                onAcceptAll={() => {}}
                onRejectAll={() => {}}
              />
            )}
            {view === "terminal" && (
              <Suspense
                fallback={
                  <div className="p-4 text-muted-foreground text-xs">
                    Loading...
                  </div>
                }
              >
                <Terminal />
              </Suspense>
            )}
            {view === "skills" && <SkillsPanel />}
            {view === "providers" && (
              <div className="p-6">
                <ProviderSettings />
              </div>
            )}
          </main>

          {/* Sidebar toggle */}
          <div className="flex h-7 items-center border-t border-border px-2">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="btn-ghost h-6 w-6 p-0"
            >
              {sidebarOpen ? (
                <PanelLeftClose className="size-3.5" />
              ) : (
                <PanelLeft className="size-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Right panel */}
        {rightPanel === "files" && (
          <div className="w-72 shrink-0 border-l border-border bg-sidebar flex flex-col">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-xs font-medium">Files</span>
              <button
                onClick={() => setRightPanel(null)}
                className="btn-ghost h-6 w-6 p-0"
              >
                <PanelLeftClose className="size-3.5 rotate-180" />
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              <FileTree />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
