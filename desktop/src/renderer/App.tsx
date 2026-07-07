import {
  useState,
  useCallback,
  useEffect,
  lazy,
  Suspense,
  type ReactNode,
} from "react";
import {
  Home,
  Code,
  Plus,
  Sparkles,
  Settings,
  Blocks,
  Terminal as TerminalIcon,
  FileDiff,
  PanelRight,
  PanelLeft,
  Sun,
  Moon,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { ChatView, usePermissionHandler } from "@/components/chat/ChatView";
import { SessionList } from "@/components/SessionList";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { SkillsPanel } from "@/components/SkillsPanel";
import { DiffViewer, type DiffFile } from "@/components/diff/DiffViewer";
import { FileTree } from "@/components/FileTree";
import { ClaudeMark } from "@/components/ClaudeMark";
import { WindowControls } from "@/components/WindowControls";
import { AccountMenu } from "@/components/AccountMenu";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Modal } from "@/components/ui/modal";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useChatStore } from "@/stores/chatStore";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types/chat";
import type { ElectronAPI } from "@/types/electron";

const Terminal = lazy(() =>
  import("@/components/Terminal").then((m) => ({ default: m.Terminal })),
);

type View = "chat" | "changes" | "skills";
type RightTab = "files" | "artifacts" | null;

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function useTheme(): {
  theme: "light" | "dark";
  setTheme: (t: "light" | "dark") => void;
  toggle: () => void;
} {
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
  const toggle = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    [],
  );
  return { theme, setTheme, toggle };
}

/** Ghost icon button used in the header. */
function IconBtn({
  active,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  title: string;
  onClick?: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "app-no-drag flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]",
        active && "bg-black/[0.06] text-foreground dark:bg-white/[0.08]",
      )}
    >
      {children}
    </button>
  );
}

/** Sidebar navigation row. */
function NavRow({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]",
        active && "bg-black/[0.06] text-foreground dark:bg-white/[0.08]",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** Rounded floating "window" card that panels live in. */
function Panel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

export default function App(): JSX.Element {
  const [view, setView] = useState<View>("chat");
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [sessionTitle, setSessionTitle] = useState("New session");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>(null);
  const [diffs] = useState<DiffFile[]>([]);
  const { theme, setTheme, toggle } = useTheme();
  const chatStore = useChatStore();

  usePermissionHandler();

  useEffect(() => {
    api()
      ?.workspace.get()
      .then((ws) => {
        document.title = `Claude Code — ${ws.split(/[/\\]/).pop() || ws}`;
      })
      .catch(() => {});
  }, []);

  // Ctrl+, opens settings (like the official app).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleSelectSession = useCallback(
    (session: { id: string; title: string; messages: ChatMessage[] }) => {
      setCurrentSessionId(session.id);
      setSessionTitle(session.title || "New session");
      setView("chat");
      chatStore.clearMessages();
      useChatStore.setState({ messages: session.messages });
    },
    [chatStore],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      try {
        await api()?.sessions.deleteById(id);
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

  const newSession = useCallback(async () => {
    try {
      const s = (await api()?.sessions.create()) as
        { id: string; title: string } | undefined;
      if (s) handleSelectSession({ id: s.id, title: s.title, messages: [] });
    } catch {
      /* offline / no preload */
    }
    setView("chat");
  }, [handleSelectSession]);

  const toggleRight = (tab: Exclude<RightTab, null>): void =>
    setRightTab((cur) => (cur === tab ? null : tab));

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-sidebar text-foreground">
      {/* ── Custom title bar ── */}
      <header className="app-drag flex h-11 shrink-0 items-center gap-2 pl-2">
        <IconBtn
          title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          onClick={() => setSidebarOpen((o) => !o)}
        >
          <PanelLeft className="size-4" />
        </IconBtn>

        <div className="app-no-drag flex items-center gap-2">
          <div className="flex size-5 items-center justify-center rounded-[5px] bg-brand text-white">
            <ClaudeMark className="size-3" />
          </div>
          <div className="flex h-7 items-center rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.06]">
            <button
              onClick={() => setView("chat")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                view === "chat"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Home className="size-3" /> Home
            </button>
            <button
              onClick={() => setView("chat")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                view !== "chat"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Code className="size-3" /> Code
            </button>
          </div>
          <span className="ml-1 max-w-[32ch] truncate text-[13px] text-muted-foreground">
            {sessionTitle}
          </span>
        </div>

        <div className="flex-1" />

        <div className="app-no-drag flex items-center gap-0.5 pr-1.5">
          <IconBtn
            title="Files"
            active={rightTab === "files"}
            onClick={() => toggleRight("files")}
          >
            <PanelRight className="size-4" />
          </IconBtn>
          <IconBtn
            title="Terminal"
            active={terminalOpen}
            onClick={() => setTerminalOpen((o) => !o)}
          >
            <TerminalIcon className="size-4" />
          </IconBtn>
          <IconBtn
            title="Changes"
            active={view === "changes"}
            onClick={() => setView("changes")}
          >
            <FileDiff className="size-4" />
          </IconBtn>
          <IconBtn title="Settings" onClick={() => setSettingsOpen(true)}>
            <Settings className="size-4" />
          </IconBtn>
          <IconBtn title="Toggle theme" onClick={toggle}>
            {theme === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </IconBtn>
        </div>

        <WindowControls />
      </header>

      {/* ── Body ── */}
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className="flex w-60 shrink-0 flex-col rounded-xl border border-border bg-card shadow-sm mx-1.5 my-1.5">
            <div className="flex flex-col gap-0.5 px-2">
              <NavRow icon={Plus} label="New session" onClick={newSession} />
              <NavRow
                icon={Blocks}
                label="Artifacts"
                active={rightTab === "artifacts"}
                onClick={() => toggleRight("artifacts")}
              />
              <NavRow
                icon={Sparkles}
                label="Skills"
                active={view === "skills"}
                onClick={() => setView("skills")}
              />
              <NavRow
                icon={Settings}
                label="Settings"
                onClick={() => setSettingsOpen(true)}
              />
            </div>

            <div className="flex min-h-0 flex-1 flex-col px-2">
              <div className="flex items-center justify-between px-2 pt-3 pb-1">
                <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                  Recents
                </span>
                <Search className="size-3 text-muted-foreground" />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                <SessionList
                  onSelect={handleSelectSession}
                  onDelete={handleDeleteSession}
                  currentSessionId={currentSessionId}
                />
              </div>
            </div>

            <div className="p-1.5">
              <WorkspacePicker />
              <AccountMenu onOpenSettings={() => setSettingsOpen(true)} />
            </div>
          </aside>
        )}

        {/* Resizable "window" panels */}
        <div className="min-w-0 flex-1">
          <ResizablePanelGroup
            key={rightTab ? "with-right" : "no-right"}
            direction="horizontal"
          >
            <ResizablePanel defaultSize={72} minSize={32}>
              <ResizablePanelGroup
                key={terminalOpen ? "with-term" : "no-term"}
                direction="vertical"
              >
                <ResizablePanel minSize={25}>
                  <div className="flex h-full min-h-0 flex-col overflow-hidden">
                    {view === "chat" && <ChatView />}
                    {view === "changes" && (
                      <div className="h-full overflow-auto">
                        <DiffViewer
                          files={diffs}
                          onAccept={() => {}}
                          onReject={() => {}}
                          onAcceptAll={() => {}}
                          onRejectAll={() => {}}
                        />
                      </div>
                    )}
                    {view === "skills" && (
                      <div className="h-full overflow-auto">
                        <SkillsPanel />
                      </div>
                    )}
                  </div>
                </ResizablePanel>

                {terminalOpen && (
                  <>
                    <ResizableHandle withHandle />
                    <ResizablePanel defaultSize={32} minSize={12}>
                      <Panel>
                        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                          <span className="text-xs font-medium text-muted-foreground">
                            Terminal
                          </span>
                          <button
                            type="button"
                            onClick={() => setTerminalOpen(false)}
                            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                        <Suspense
                          fallback={
                            <div className="p-3 text-xs text-muted-foreground">
                              Loading terminal…
                            </div>
                          }
                        >
                          <Terminal />
                        </Suspense>
                      </Panel>
                    </ResizablePanel>
                  </>
                )}
              </ResizablePanelGroup>
            </ResizablePanel>

            {rightTab && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={30} minSize={18} maxSize={48}>
                  <Panel>
                    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
                      <button
                        onClick={() => setRightTab("files")}
                        className={cn(
                          "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                          rightTab === "files"
                            ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        Files
                      </button>
                      <button
                        onClick={() => setRightTab("artifacts")}
                        className={cn(
                          "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                          rightTab === "artifacts"
                            ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        Artifacts
                      </button>
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={() => setRightTab(null)}
                        aria-label="Close panel"
                        className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto">
                      {rightTab === "files" ? (
                        <FileTree />
                      ) : (
                        <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
                          Artifacts published in this session appear here.
                        </div>
                      )}
                    </div>
                  </Panel>
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </div>
      </div>

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        bare
        className="h-[80vh] max-w-4xl"
      >
        <SettingsPanel theme={theme} setTheme={setTheme} />
      </Modal>
    </div>
  );
}
