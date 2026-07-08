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
  MoreVertical,
  Ghost,
  ChevronDown,
  X,
  ListTodo,
  Pencil,
  FileText,
  GitFork,
  Archive,
  Trash2,
  ExternalLink,
  Columns2,
  Monitor,
  type LucideIcon,
} from "lucide-react";
import { ChatView, PermissionHost } from "@/components/chat/ChatView";
import { SessionList } from "@/components/SessionList";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { FilterDropdown } from "@/components/FilterDropdown";
import { SkillsPanel } from "@/components/SkillsPanel";
import { DiffViewer, type DiffFile } from "@/components/diff/DiffViewer";
import { FileTree } from "@/components/FileTree";
import { FileViewer } from "@/components/FileViewer";
import { WindowControls } from "@/components/WindowControls";
import { AccountMenu } from "@/components/AccountMenu";
import { AboutPanel } from "@/components/AboutPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Modal } from "@/components/ui/modal";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
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
type TranscriptMode = "normal" | "thinking" | "verbose" | "summary";

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
  // Home = simple centered chat (no IDE chrome). Code = the full IDE shell
  // (terminal, files, changes, resizable panels).
  const [appMode, setAppMode] = useState<"home" | "code">("home");
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [sessionTitle, setSessionTitle] = useState("New session");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [transcriptMode, setTranscriptMode] =
    useState<TranscriptMode>("normal");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [diffs] = useState<DiffFile[]>([]);
  const { theme, setTheme, toggle } = useTheme();
  const chatStore = useChatStore();

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
      useChatStore.setState({
        messages: session.messages,
        currentSessionId: session.id,
        usage: null,
      });
    },
    [chatStore],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      try {
        await api()?.sessions.deleteById(id);
        useChatStore.getState().bumpSessions();
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
      if (s) {
        await api()?.chat.reset(s.id);
        handleSelectSession({ id: s.id, title: s.title, messages: [] });
        useChatStore.getState().bumpSessions();
      }
    } catch {
      /* offline / no preload */
    }
    setView("chat");
  }, [handleSelectSession]);

  const toggleRight = (tab: Exclude<RightTab, null>): void =>
    setRightTab((cur) => (cur === tab ? null : tab));

  // Fork: copy the current conversation into a fresh saved session and switch
  // to it. The display messages are preserved; the next send seeds the agent
  // via chat:send's `seed` param.
  const handleFork = useCallback(async () => {
    const store = useChatStore.getState();
    const msgs = store.messages;
    if (msgs.length === 0) return;
    try {
      const s = (await api()?.sessions.create()) as { id: string } | undefined;
      if (s?.id) {
        await api()?.sessions.save({
          id: s.id,
          title: `${sessionTitle || "Chat"} (fork)`,
          messages: msgs,
        });
        store.setCurrentSessionId(s.id);
        setCurrentSessionId(s.id);
        store.bumpSessions();
      }
    } catch {
      /* offline */
    }
  }, [sessionTitle]);

  const handleRename = useCallback(async () => {
    const id = useChatStore.getState().currentSessionId;
    const title = renameValue.trim();
    if (id && title) {
      try {
        await api()?.sessions.updateTitle(id, title);
        setSessionTitle(title);
        useChatStore.getState().bumpSessions();
      } catch {
        /* offline */
      }
    }
    setRenameOpen(false);
  }, [renameValue]);

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
          <span className="font-[Copernicus] text-[15px] font-semibold tracking-tight text-foreground">
            Monet
          </span>
        </div>

        <div className="flex-1" />

        <div className="app-no-drag flex items-center gap-0.5 pr-1.5">
          {appMode === "code" && (
            <>
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
                onClick={() =>
                  setView((v) => (v === "changes" ? "chat" : "changes"))
                }
              >
                <FileDiff className="size-4" />
              </IconBtn>
            </>
          )}
          <IconBtn
            title={
              chatStore.incognito
                ? "Incognito on — this chat isn't saved"
                : "Incognito mode"
            }
            active={chatStore.incognito}
            onClick={() => {
              const store = useChatStore.getState();
              if (store.currentSessionId)
                void api()?.chat.reset(store.currentSessionId);
              store.clearMessages();
              store.setCurrentSessionId(undefined);
              setCurrentSessionId(undefined);
              store.setIncognito(!store.incognito);
              setView("chat");
            }}
          >
            <Ghost className="size-4" />
          </IconBtn>

          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title="More"
                aria-label="More"
                className="app-no-drag flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
              >
                <MoreVertical className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem
                onClick={() => {
                  toggleRight("artifacts");
                  setMenuOpen(false);
                }}
              >
                <Blocks className="size-4" />
                Artifacts
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  toggleRight("files");
                  setMenuOpen(false);
                }}
              >
                <PanelRight className="size-4" />
                Files
                <DropdownMenuShortcut>Ctrl+^+F</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setAppMode("code");
                  setTerminalOpen(true);
                  setMenuOpen(false);
                }}
              >
                <TerminalIcon className="size-4" />
                Terminal
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setAppMode("code");
                  toggleRight("files");
                  setMenuOpen(false);
                }}
              >
                <Columns2 className="size-4" />
                Split view
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  void api()?.win.newWindow();
                  setMenuOpen(false);
                }}
              >
                <Monitor className="size-4" />
                New window
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                onClick={() => {
                  setRenameValue(sessionTitle || "");
                  setRenameOpen(true);
                  setMenuOpen(false);
                }}
              >
                <Pencil className="size-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setMenuOpen(false);
                  void handleFork();
                }}
              >
                <GitFork className="size-4" />
                Fork
              </DropdownMenuItem>

              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FileText className="size-4" />
                  Transcript view
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {(
                    [
                      "normal",
                      "thinking",
                      "verbose",
                      "summary",
                    ] as TranscriptMode[]
                  ).map((m) => (
                    <DropdownMenuItem
                      key={m}
                      onClick={() => {
                        setTranscriptMode(m);
                        setMenuOpen(false);
                      }}
                    >
                      <span
                        className={m === transcriptMode ? "font-medium" : ""}
                      >
                        {m.charAt(0).toUpperCase() + m.slice(1)}
                      </span>
                      {m === transcriptMode && (
                        <span className="ml-auto size-1.5 rounded-full bg-link" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  setMenuOpen(false);
                  const id = useChatStore.getState().currentSessionId;
                  if (id) void handleDeleteSession(id);
                }}
              >
                <Trash2 className="size-4" />
                Delete chat
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <WindowControls />
      </header>

      {/* ── Body ── */}
      <div className="flex min-h-0 flex-1 p-2">
        <ResizablePanelGroup direction="horizontal" className="gap-1">
          {sidebarOpen && (
            <>
              <ResizablePanel
                defaultSize={18}
                minSize={14}
                maxSize={38}
                className="min-w-[280px]"
              >
                <aside className="flex h-full flex-col rounded-xl border border-border bg-card shadow-sm">
                  {/* Home / Code tabs */}
                  <div className="flex items-center gap-1 px-2 pt-2">
                    <div className="flex h-7 flex-1 items-center rounded-md bg-black/[0.05] p-0.5 dark:bg-white/[0.06]">
                      <button
                        onClick={() => {
                          setAppMode("home");
                          setView("chat");
                        }}
                        className={cn(
                          "flex flex-1 items-center justify-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
                          appMode === "home"
                            ? "bg-card text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <Home className="size-3" />
                        Home
                      </button>
                      <button
                        onClick={() => {
                          setAppMode("code");
                          setView("chat");
                        }}
                        className={cn(
                          "flex flex-1 items-center justify-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
                          appMode === "code"
                            ? "bg-card text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <Code className="size-3" />
                        Code
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-0.5 px-2 pt-1">
                    <NavRow
                      icon={Plus}
                      label="New session"
                      onClick={newSession}
                    />
                    <NavRow
                      icon={Blocks}
                      label="Artifacts"
                      active={rightTab === "artifacts"}
                      onClick={() => toggleRight("artifacts")}
                    />
                    <NavRow
                      icon={Settings}
                      label="Customize"
                      onClick={() => setSettingsOpen(true)}
                    />
                  </div>

                  <div className="flex min-h-0 flex-1 flex-col px-2">
                    <div className="flex items-center justify-between px-2 pb-1 pt-3">
                      <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                        Recents
                      </span>
                      <FilterDropdown />
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                      <SessionList
                        onSelect={handleSelectSession}
                        onDelete={handleDeleteSession}
                        currentSessionId={currentSessionId}
                      />
                    </div>
                  </div>

                  <div className="p-1">
                    <AccountMenu
                      onOpenSettings={() => setSettingsOpen(true)}
                      onOpenAbout={() => setAboutOpen(true)}
                    />
                  </div>
                </aside>
              </ResizablePanel>
              <ResizableHandle withHandle />
            </>
          )}

          {/* Content panel group */}
          <ResizablePanel defaultSize={sidebarOpen ? 82 : 100} minSize={30}>
            {appMode === "home" ? (
              // Home: a plain, centered chat — no IDE chrome (terminal, files,
              // changes, resizable splits). The greeting/tamagotchi lives in
              // ChatView's empty state.
              <div className="h-full min-h-0 overflow-hidden">
                {openFilePath ? (
                  <FileViewer
                    path={openFilePath}
                    onClose={() => setOpenFilePath(null)}
                  />
                ) : (
                  <ChatView
                    transcriptMode={transcriptMode}
                    sessionTitle={sessionTitle}
                  />
                )}
              </div>
            ) : (
              <ResizablePanelGroup direction="horizontal" className="gap-1">
              <ResizablePanel defaultSize={72} minSize={25}>
                <ResizablePanelGroup direction="vertical" className="gap-1">
                  <ResizablePanel minSize={20}>
                    <div className="flex h-full min-h-0 flex-col overflow-hidden">
                      {openFilePath ? (
                        <FileViewer
                          path={openFilePath}
                          onClose={() => setOpenFilePath(null)}
                        />
                      ) : (
                        <>
                          {view === "chat" && (
                            <ChatView
                              transcriptMode={transcriptMode}
                              sessionTitle={sessionTitle}
                            />
                          )}
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
                        </>
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
                  <ResizablePanel
                    key="right-panel"
                    defaultSize={30}
                    minSize={18}
                    maxSize={48}
                  >
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
                        <div className={rightTab === "files" ? "" : "hidden"}>
                          <FileTree onSelectFile={(p) => setOpenFilePath(p)} />
                        </div>
                        <div
                          className={rightTab === "artifacts" ? "" : "hidden"}
                        >
                          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
                            Artifacts published in this session appear here.
                          </div>
                        </div>
                      </div>
                    </Panel>
                  </ResizablePanel>
                </>
              )}
              </ResizablePanelGroup>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <Modal
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        bare
        className="h-[80vh] max-w-4xl"
      >
        <AboutPanel />
      </Modal>

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        bare
        className="h-[80vh] max-w-4xl"
      >
        <SettingsPanel theme={theme} setTheme={setTheme} />
      </Modal>

      <Modal open={renameOpen} onClose={() => setRenameOpen(false)}>
        <div className="p-5">
          <h3 className="text-base font-semibold">Rename chat</h3>
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRename();
              if (e.key === "Escape") setRenameOpen(false);
            }}
            placeholder="Chat name"
            className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground/20"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setRenameOpen(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleRename()}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Save
            </button>
          </div>
        </div>
      </Modal>

      <PermissionHost />
    </div>
  );
}
