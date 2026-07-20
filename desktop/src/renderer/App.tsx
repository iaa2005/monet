import {
  useState,
  useCallback,
  useEffect,
  useRef,
  lazy,
  Suspense,
  Component,
  Fragment,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  useMonetBackground,
  bgOpacity,
  ROTATE_OPTIONS,
} from "./components/useMonetBackground.js";
import {
  Home,
  Code,
  Plus,
  Sparkles,
  Files,
  Blocks,
  Terminal as TerminalIcon,
  FileDiff,
  PanelLeft,
  MoreVertical,
  Ghost,
  ChevronDown,
  X,
  ListTodo,
  Pencil,
  FileText,
  Upload,
  Zap,
  GitFork,
  Archive,
  Trash2,
  ExternalLink,
  Monitor,
  ChevronRight,
  Cpu,
  Check,
  type LucideIcon,
} from "lucide-react";
import { ChatView, PermissionHost } from "@/components/chat/ChatView";
import { SessionList } from "@/components/SessionList";
import { ArtifactsPanel } from "@/components/ArtifactsPanel";
import { ChangesPanel } from "@/components/ChangesPanel";
import { SandboxFilesPanel } from "@/components/SandboxFilesPanel";
import { BackgroundTasks } from "@/components/BackgroundTasks";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { FilterDropdown } from "@/components/FilterDropdown";
import { SkillsPanel } from "@/components/SkillsPanel";
import { FileTree } from "@/components/FileTree";
import { FileViewer } from "@/components/FileViewer";
import { SubAgentTranscript } from "@/components/chat/ToolCallBubble";
import { WindowControls } from "@/components/WindowControls";
import { BetaBadge } from "@/components/BetaBadge";
import { AccountMenu } from "@/components/AccountMenu";
import { AboutPanel } from "@/components/AboutPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { OnboardingIntro } from "@/components/OnboardingIntro";
import { RoutinesSettings } from "@/components/settings/RoutinesSettings";
import { Modal } from "@/components/ui/modal";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { RoutinesList } from "@/components/RoutinesList";
import type { ChatMessage } from "@/types/chat";
import type { ElectronAPI } from "@/types/electron";

const Terminal = lazy(() =>
  import("@/components/Terminal").then((m) => ({ default: m.Terminal })),
);

type View = "chat" | "skills" | "routines";
type RightTab = "files" | "artifacts" | "changes" | null;
type TranscriptMode = "normal" | "thinking" | "verbose" | "summary";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

class ViewerErrorBoundary extends Component<
  { children: ReactNode; onClose: () => void },
  { error: Error | null; retryKey: number }
> {
  state: { error: Error | null; retryKey: number } = {
    error: null,
    retryKey: 0,
  };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[renderer] FileViewer render error", error, info.componentStack);
  }

  private retry = (): void => {
    this.setState(({ retryKey }) => ({ error: null, retryKey: retryKey + 1 }));
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm font-medium text-destructive">File preview failed</p>
          <p className="max-w-md text-xs text-muted-foreground">
            {this.state.error.message || "The file preview could not be rendered."}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.retry}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={this.props.onClose}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
            >
              Close
            </button>
          </div>
        </div>
      );
    }
    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }
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

/** Per-chat sandbox-engine picker labels (Home header). */
const ENGINE_LABEL: Record<"pyodide" | "subprocess" | "docker", string> = {
  pyodide: "Pyodide",
  subprocess: "Subprocess",
  docker: "Podman",
};
const ENGINE_DESC: Record<"pyodide" | "subprocess" | "docker", string> = {
  pyodide: "WebAssembly · isolated · no shell",
  subprocess: "Host Python/Node · weak isolation",
  docker: "Container · full shell, pip, LaTeX",
};

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
        "glass-panel flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

export default function App(): JSX.Element {
  // First-run intro: shown until the user completes (or skips) onboarding.
  const [showOnboarding, setShowOnboarding] = useState(
    () => !localStorage.getItem("monet-onboarded"),
  );
  const [view, setView] = useState<View>("chat");
  // Home = simple centered chat (no IDE chrome). Code = the full IDE shell
  // (terminal, files, changes, resizable panels).
  const [appMode, setAppMode] = useState<"home" | "code">("home");
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [sessionTitle, setSessionTitle] = useState("New session");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"general" | "sandbox" | "providers">("general");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameTargetId, setRenameTargetId] = useState<string | undefined>();
  const [rotateMenuOpen, setRotateMenuOpen] = useState(false);
  const [incognitoCloseOpen, setIncognitoCloseOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [transcriptMode, setTranscriptMode] =
    useState<TranscriptMode>("normal");
  const [terminalOpen, setTerminalOpen] = useState(false);
  // The engine THIS chat runs on (per-chat override, else the global default).
  // Home terminal is available only when it has a real shell (Podman /
  // subprocess); Pyodide is WebAssembly — no shell.
  const [sessionEngine, setSessionEngine] =
    useState<"pyodide" | "subprocess" | "docker">("pyodide");
  const [homeShellSupported, setHomeShellSupported] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>(null);
  const [filters, setFilters] = useState({
    status: "all",
    activity: "all",
    group: "none",
    sort: "recency",
    sortDir: "desc" as "asc" | "desc",
  });
  const { theme, setTheme, toggle } = useTheme();
  // Narrow subscriptions only — subscribing to the whole store re-rendered
  // the entire app on every streaming update (a major lag source).
  const incognito = useChatStore((s) => s.incognito);
  const openFileRequest = useChatStore((s) => s.openFileRequest);
  const openChangesRequest = useChatStore((s) => s.openChangesRequest);
  const viewer = useChatStore((s) => s.viewer);
  const expandedSubAgent = useChatStore((s) => s.expandedSubAgent);
  const closeViewer = useCallback(
    () => useChatStore.getState().openViewer(null),
    [],
  );
  const closeExpandedSubAgent = useCallback(
    () => useChatStore.getState().openExpandedSubAgent(null),
    [],
  );

  // Tool file links ask to open a file in the in-app viewer.
  useEffect(() => {
    if (openFileRequest) {
      const path = openFileRequest;
      useChatStore.getState().openViewer({
        name: path.split(/[/\\]/).pop() || path,
        path,
        mediaType: "application/octet-stream",
        kind: "file",
        source: "file",
      });
      useChatStore.getState().requestOpenFile(null);
    }
  }, [openFileRequest]);

  // GitCard's "+N −M" button asks to open the Changes tab.
  useEffect(() => {
    if (openChangesRequest) {
      setRightTab("changes");
      useChatStore.getState().requestOpenChanges();
      useChatStore.setState({ openChangesRequest: false });
    }
  }, [openChangesRequest]);

  useEffect(() => {
    api()
      ?.workspace.get()
      .then((ws) => {
        document.title = `Code Monet — ${ws.split(/[/\\]/).pop() || ws}`;
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
    (session: {
      id: string;
      title: string;
      messages: ChatMessage[];
      workspace?: string;
    }) => {
      setCurrentSessionId(session.id);
      setSessionTitle(session.title || "New session");
      setView("chat");
      const store = useChatStore.getState();
      // Switch first (shows the live buffer if this chat is running in the
      // background), then seed from the DB only if it isn't.
      store.setCurrentSessionId(session.id);
      store.loadSessionMessages(session.id, session.messages);
      // Restore the chat's own working directory (chats without one keep
      // whatever folder is current).
      if (session.workspace) {
        void api()
          ?.workspace.set(session.workspace)
          .then(() => useChatStore.getState().bumpWorkspace())
          .catch(() => {
            /* folder may be gone */
          });
      }
    },
    [],
  );

  // Jump to a chat that's streaming in the background. We only switch the
  // visible session to its live buffer — never reload from the DB, which could
  // be mid-write — and refresh the title best-effort for saved sessions.
  const openBackgroundTask = useCallback((id: string) => {
    const store = useChatStore.getState();
    store.setCurrentSessionId(id);
    setCurrentSessionId(id);
    setView("chat");
    if (id.startsWith("incognito-")) {
      setSessionTitle("Incognito chat");
      return;
    }
    void api()
      ?.sessions.getById(id)
      .then((s) => {
        const sess = s as { title?: string } | null | undefined;
        if (sess?.title) setSessionTitle(sess.title);
      })
      .catch(() => {
        /* offline */
      });
  }, []);

  // App-level stream router: one listener, forever. Each event is tagged with
  // its sessionId so background chats keep updating their own state while the
  // user views (or works in) a different one.
  useEffect(() => {
    const bridge = api();
    if (!bridge?.chat?.onToken) return;
    return bridge.chat.onToken(({ sessionId, event }) => {
      useChatStore.getState().handleLLMEvent(sessionId, event);
    });
  }, []);

  // Keep the store's space in sync with the visible mode so new chats
  // (created in MessageInput) are tagged with the right workspace.
  useEffect(() => {
    useChatStore.getState().setSpace(appMode);
  }, [appMode]);

  // Resolve THIS chat's engine + whether it has a shell. Re-read when the chat
  // changes and when Settings closes (the global default may have changed).
  useEffect(() => {
    if (appMode !== "home" || !currentSessionId) {
      setHomeShellSupported(false);
      return;
    }
    let alive = true;
    void api()
      ?.sandbox.getSessionConfig(currentSessionId)
      .then((c) => {
        if (!alive) return;
        setSessionEngine(c.engine as "pyodide" | "subprocess" | "docker");
        setHomeShellSupported(c.engine !== "pyodide");
      });
    return () => {
      alive = false;
    };
  }, [appMode, currentSessionId, settingsOpen]);

  // Pin the current chat to an engine (per-chat override). Files in /work carry
  // over — only the runtime changes — so switching mid-chat is safe.
  const changeSessionEngine = useCallback(
    (engine: "pyodide" | "subprocess" | "docker") => {
      const sid = currentSessionId;
      if (!sid) return;
      setSessionEngine(engine);
      const hasShell = engine !== "pyodide";
      setHomeShellSupported(hasShell);
      if (!hasShell) setTerminalOpen(false); // Pyodide has no terminal
      void api()?.sandbox.setSessionConfig(sid, engine);
    },
    [currentSessionId],
  );

  // Runner for the Home terminal: execute inside the current chat's sandbox.
  const sandboxRunner = useCallback(
    async (command: string) => {
      const sid = currentSessionId;
      if (!sid) return { error: "Open or start a Home chat first." };
      const r = await api()?.sandbox.shellRun(sid, command);
      return r ?? { error: "Sandbox unavailable." };
    },
    [currentSessionId],
  );

  // Auto-title from main (first completed exchange names the chat) — update
  // the header when it's the visible chat, refresh the sidebar always.
  useEffect(() => {
    const bridge = api();
    if (!bridge?.sessions?.onTitleChanged) return;
    return bridge.sessions.onTitleChanged(({ sessionId, title }) => {
      if (useChatStore.getState().currentSessionId === sessionId)
        setSessionTitle(title);
      useChatStore.getState().bumpSessions();
    });
  }, []);

  // Header title follows sidebar renames / auto-derived titles: whenever the
  // session list changes, re-read the visible chat's title. (Renaming from
  // the sidebar updated the list but left the header on the old name.)
  const sessionsVersion = useChatStore((s) => s.sessionsVersion);
  useEffect(() => {
    const id = useChatStore.getState().currentSessionId;
    if (!id || id.startsWith("incognito-")) return;
    void api()
      ?.sessions.getById(id)
      .then((s) => {
        const t = (s as { title?: string } | null | undefined)?.title;
        if (t) setSessionTitle(t);
      })
      .catch(() => {});
  }, [sessionsVersion]);

  // Home and Code are separate worlds: each keeps its own current chat.
  // Switching restores the last chat of the target space, or a blank chat
  // if none was open there.
  const lastSessionBySpace = useRef<Record<string, string | undefined>>({});
  const prevSpaceRef = useRef(appMode);
  useEffect(() => {
    const prev = prevSpaceRef.current;
    if (prev === appMode) return;
    lastSessionBySpace.current[prev] =
      useChatStore.getState().currentSessionId;
    prevSpaceRef.current = appMode;

    const target = lastSessionBySpace.current[appMode];
    if (target) {
      void api()
        ?.sessions.getById(target)
        .then((s) => {
          if (s)
            handleSelectSession(
              s as {
                id: string;
                title: string;
                messages: ChatMessage[];
                workspace?: string;
              },
            );
        })
        .catch(() => {});
    } else {
      const store = useChatStore.getState();
      store.setCurrentSessionId(undefined);
      store.clearMessages();
      setCurrentSessionId(undefined);
      setSessionTitle("New session");
      setView("chat");
    }
  }, [appMode, handleSelectSession]);

  // Confirmed incognito exit: purge every trace of the session (artifacts,
  // sandbox, main-process history), then leave incognito.
  const closeIncognito = useCallback(() => {
    const store = useChatStore.getState();
    const sid = store.currentSessionId;
    if (sid) {
      void api()?.chat.reset(sid);
      void api()?.incognito.purge(sid);
    }
    store.clearMessages();
    store.setCurrentSessionId(undefined);
    setCurrentSessionId(undefined);
    store.setIncognito(false);
    setIncognitoCloseOpen(false);
    setView("chat");
  }, []);

  const newSession = useCallback(async () => {
    try {
      const s = (await api()?.sessions.create(
        undefined,
        useChatStore.getState().space,
      )) as { id: string; title: string } | undefined;
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

  const openChatById = useCallback(
    async (id: string) => {
      try {
        const s = (await api()?.sessions.getById(id)) as
          | { id: string; title: string; messages: ChatMessage[]; workspace?: string }
          | null
          | undefined;
        if (s)
          handleSelectSession({
            id: s.id,
            title: s.title,
            messages: s.messages,
            workspace: s.workspace,
          });
      } catch {
        /* session may be gone */
      }
    },
    [handleSelectSession],
  );

  const handleImport = useCallback(async () => {
    try {
      const r = await api()?.transfer.importChat();
      if (r?.ok && r.session) {
        handleSelectSession({
          id: r.session.id,
          title: r.session.title,
          messages: r.session.messages,
        });
        useChatStore.getState().bumpSessions();
        setView("chat");
      } else if (r && !r.canceled && r.error) {
        console.error("Import failed:", r.error);
      }
    } catch (err) {
      console.error("Import failed:", err);
    }
  }, [handleSelectSession]);

  const handleDeleteSession = useCallback(
    async (id: string) => {
      try {
        await api()?.sessions.deleteById(id);
        useChatStore.getState().bumpSessions();
        if (id === currentSessionId) {
          // Clear the active session without spawning a replacement —
          // creating a new empty row for every deletion is what left
          // orphan "New session" entries behind when the user tried to
          // clean up the list.
          useChatStore.getState().clearMessages();
          useChatStore.getState().setCurrentSessionId(undefined);
          setCurrentSessionId(undefined);
          setSessionTitle("New session");
        }
      } catch (err) {
        console.error("Failed to delete session:", err);
      }
    },
    [currentSessionId],
  );

  const toggleRight = (tab: Exclude<RightTab, null>): void =>
    setRightTab((cur) => (cur === tab ? null : tab));

  // Fork: copy the current conversation into a fresh saved session and switch
  // to it. The display messages are preserved; the next send seeds the agent
  // via chat:send's `seed` param.
  const handleFork = useCallback(async () => {
    const store = useChatStore.getState();
    const msgs = store.messages;
    if (msgs.length === 0) return;
    // messages.id is a GLOBAL primary key in the DB, so a fork must give the
    // copied messages fresh ids — otherwise saving the fork collides with the
    // originals (SQLITE_CONSTRAINT_PRIMARYKEY). Regenerate in the store too so
    // the fork's future auto-saves keep using the new ids.
    const newId = (): string =>
      crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
    const forked = msgs.map((m) => ({ ...m, id: newId() }));
    try {
      const s = (await api()?.sessions.create()) as { id: string } | undefined;
      if (s?.id) {
        await api()?.sessions.save({
          id: s.id,
          title: `${sessionTitle || "Chat"} (fork)`,
          messages: forked,
        });
        store.loadSessionMessages(s.id, forked);
        store.setCurrentSessionId(s.id);
        setCurrentSessionId(s.id);
        store.bumpSessions();
      }
    } catch {
      /* offline */
    }
  }, [sessionTitle]);

  const handleRename = useCallback(async () => {
    const id = renameTargetId ?? useChatStore.getState().currentSessionId;
    const title = renameValue.trim();
    if (id && title) {
      try {
        await api()?.sessions.updateTitle(id, title);
        if (id === useChatStore.getState().currentSessionId)
          setSessionTitle(title);
        useChatStore.getState().bumpSessions();
      } catch {
        /* offline */
      }
    }
    setRenameOpen(false);
  }, [renameValue, renameTargetId]);

  // Fork any session by id (sidebar menu) — load it, give the copies fresh
  // message ids, save into a new session in the current space, switch to it.
  const forkSession = useCallback(
    async (id: string) => {
      try {
        const session = (await api()?.sessions.getById(id)) as
          | { id: string; title: string; messages: ChatMessage[] }
          | null
          | undefined;
        if (!session) return;
        const newId = (): string =>
          crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
        const forked = session.messages.map((m) => ({ ...m, id: newId() }));
        const title = `${session.title || "Chat"} (fork)`;
        const s = (await api()?.sessions.create(
          title,
          useChatStore.getState().space,
        )) as { id: string } | undefined;
        if (s?.id) {
          await api()?.sessions.save({ id: s.id, title, messages: forked });
          useChatStore.getState().bumpSessions();
          handleSelectSession({ id: s.id, title, messages: forked });
        }
      } catch {
        /* offline */
      }
    },
    [handleSelectSession],
  );

  const { bg, title, year, toggle: toggleBg, rotateMs, setRotateMs } = useMonetBackground();
  const prevBg = useRef<string | null>(null);
  const fadeRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);

  // Background painting layers (managed via refs for smooth crossfade)
  useEffect(() => {
    const cur = currentRef.current;
    if (!cur) return;

    if (!bg) {
      // Toggle off: React handles opacity transition via style prop
      prevBg.current = null;
      return;
    }

    if (!prevBg.current) {
      // First show: fade in
      cur.style.backgroundImage = `url(${bg})`;
      cur.style.transition = "none";
      cur.style.opacity = "0";
      void cur.offsetHeight;
      cur.style.transition = "opacity 1200ms ease-in-out";
      cur.style.opacity = String(bgOpacity());
            prevBg.current = bg;
      return;
    }

    if (bg === prevBg.current) return;

    // Crossfade to new painting
    const old = prevBg.current;
    prevBg.current = bg;
    const fade = fadeRef.current;
    if (!old || !fade) return;

    // Snap fade layer to old image at full opacity
    fade.style.backgroundImage = `url(${old})`;
    fade.style.transition = "none";
    fade.style.opacity = String(bgOpacity());
    // Snap current layer to new image at zero opacity
    cur.style.backgroundImage = `url(${bg})`;
    cur.style.transition = "none";
    cur.style.opacity = "0";
    // Force paint
    void fade.offsetHeight;
    // Animate: fade out old, fade in new
    fade.style.transition = "opacity 1200ms ease-in-out";
    fade.style.opacity = "0";
    cur.style.transition = "opacity 1200ms ease-in-out";
    cur.style.opacity = String(bgOpacity());
      }, [bg]);

  // Sync glass class with background fade
  useEffect(() => {
    if (bg) {
      document.documentElement.classList.add("monet-glass");
    } else {
      const t = setTimeout(() => document.documentElement.classList.remove("monet-glass"), 700);
      return () => clearTimeout(t);
    }
  }, [bg]);

  return (
    <div className="relative flex h-screen flex-col bg-sidebar text-foreground">
      {showOnboarding && (
        <OnboardingIntro onDone={() => setShowOnboarding(false)} />
      )}
      {/* Fade-out layer (old painting) */}
      <div
        ref={fadeRef}
        className="pointer-events-none fixed inset-0"
        style={{
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundAttachment: "fixed",
          opacity: 0,
        }}
      />
      {/* Current painting */}
      <div
        ref={currentRef}
        className="pointer-events-none fixed inset-0"
        style={{
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundAttachment: "fixed",
          opacity: bg ? bgOpacity() : 0,
          transition: bg ? "none" : "opacity 1200ms ease-in-out",
        }}
      />
      <div className="flex flex-col h-full">
      {/* ── Custom title bar ── */}
      <header
        className={cn(
          "app-drag flex h-11 shrink-0 items-center gap-2 pl-2",
          incognito && "bg-card text-card-foreground rounded-t-xl",
        )}
      >
        {!incognito && (
          <IconBtn
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            onClick={() => setSidebarOpen((o) => !o)}
          >
            <PanelLeft className="size-4" />
          </IconBtn>
        )}

        <div className="app-no-drag flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={toggleBg}
              onContextMenu={(e) => { e.preventDefault(); setRotateMenuOpen((o) => !o); }}
              className="font-[Copernicus] text-[15px] font-semibold tracking-tight text-foreground cursor-pointer hover:opacity-80 transition-opacity"
            >
              Code Monet
            </button>
            <BetaBadge />
            {bg && title && (
              <span className="ml-4 text-[11px] text-muted-foreground truncate max-w-[200px]">
                {title}{year ? `, ${year}` : ""}
              </span>
            )}
            {rotateMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setRotateMenuOpen(false)} />
                <div className="absolute left-0 top-full z-50 mt-1 w-36 rounded-lg border border-border bg-popover p-1 shadow-lg">
                  {ROTATE_OPTIONS.map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => { setRotateMs(opt.ms); setRotateMenuOpen(false); if (opt.ms && !bg) toggleBg(); }}
                      className={cn(
                        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]",
                        rotateMs === opt.ms && "text-foreground font-medium",
                        rotateMs !== opt.ms && "text-muted-foreground",
                      )}
                    >
                      {opt.label}
                      {rotateMs === opt.ms && <span className="text-brand">✓</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex-1" />

        {incognito && (
          <span className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
            <Ghost className="size-4" />
            Incognito
          </span>
        )}

        <div className="app-no-drag flex items-center gap-0.5 pr-1.5">
          {/* Files: both modes (Code = workspace, Home = sandbox tree — this is
              how you "dig around" the sandbox; no host terminal needed here). */}
          <IconBtn
            title="Files"
            active={rightTab === "files"}
            onClick={() => toggleRight("files")}
          >
            <Files className="size-4" />
          </IconBtn>
          {/* Per-chat sandbox engine (VM). Global default unless pinned here —
              files carry over on switch, only the runtime changes. */}
          {appMode === "home" && currentSessionId && !incognito && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title="Sandbox engine for this chat"
                  aria-label="Sandbox engine for this chat"
                  className="app-no-drag flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
                >
                  <Cpu className="size-3.5" />
                  {ENGINE_LABEL[sessionEngine]}
                  <ChevronDown className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {(["pyodide", "subprocess", "docker"] as const).map((e) => (
                  <DropdownMenuItem
                    key={e}
                    onClick={() => changeSessionEngine(e)}
                  >
                    <Check
                      className={cn(
                        "size-4 shrink-0",
                        sessionEngine === e ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <div className="flex flex-col">
                      <span>{ENGINE_LABEL[e]}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {ENGINE_DESC[e]}
                      </span>
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Artifacts: a sandbox surface — Home only. */}
          {appMode === "home" && (
            <IconBtn
              title="Artifacts"
              active={rightTab === "artifacts"}
              onClick={() => toggleRight("artifacts")}
            >
              <Blocks className="size-4" />
            </IconBtn>
          )}
          {/* Home sandbox shell — only when the engine has one (Podman /
              subprocess). Runs inside the chat's sandbox, not on the host. */}
          {appMode === "home" && homeShellSupported && (
            <IconBtn
              title="Sandbox terminal"
              active={terminalOpen}
              onClick={() => setTerminalOpen((o) => !o)}
            >
              <TerminalIcon className="size-4" />
            </IconBtn>
          )}
          {/* Terminal + Changes are Code IDE surfaces — Code only (a host shell
              and git diffs don't belong in Home's isolated sandbox). */}
          {appMode === "code" && (
            <>
              <IconBtn
                title="Terminal"
                active={terminalOpen}
                onClick={() => setTerminalOpen((o) => !o)}
              >
                <TerminalIcon className="size-4" />
              </IconBtn>
              <IconBtn
                title="Changes"
                active={rightTab === "changes"}
                onClick={() => toggleRight("changes")}
              >
                <FileDiff className="size-4" />
              </IconBtn>
            </>
          )}
          {!incognito && (
            <BackgroundTasks
              onOpen={openBackgroundTask}
              currentSessionId={currentSessionId}
            />
          )}
          {appMode === "home" && (
            <IconBtn
              title={incognito ? "Exit incognito" : "Incognito mode"}
              active={incognito}
              onClick={() => {
                const store = useChatStore.getState();
                if (store.incognito) {
                  // Exiting DESTROYS the chat's data — confirm first.
                  setIncognitoCloseOpen(true);
                  return;
                }
                if (store.currentSessionId)
                  void api()?.chat.reset(store.currentSessionId);
                store.clearMessages();
                store.setCurrentSessionId(undefined);
                setCurrentSessionId(undefined);
                store.setIncognito(true);
                setView("chat");
              }}
            >
              {incognito ? (
                <X className="size-4" />
              ) : (
                <Ghost className="size-4" />
              )}
            </IconBtn>
          )}

          {!incognito && view === "chat" && currentSessionId && (
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
                    setRenameTargetId(undefined);
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
                    if (id) setDeleteConfirmId(id);
                  }}
                >
                  <Trash2 className="size-4" />
                  Delete chat
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <WindowControls />
      </header>

      {/* ── Body ── */}
      <div
        className={cn(
          "flex min-h-0 flex-1 p-2",
          incognito && "bg-card text-card-foreground",
        )}
      >
        <ResizablePanelGroup
          direction="horizontal"
          className={cn(
            "gap-1",
            incognito && "rounded-xl bg-sidebar p-1",
          )}
        >
          {sidebarOpen && !incognito && (
            <>
              <ResizablePanel
                defaultSize={18}
                minSize={14}
                maxSize={38}
                className="min-w-[280px]"
                style={{ overflow: "visible" }}
              >
                <aside className="glass-panel flex h-full flex-col rounded-xl border border-border bg-card shadow-sm">
                  {/* Home / Code tabs */}
                  <div className="flex items-center gap-1 px-2 pt-2">
                    <div className="flex flex-1 items-center rounded-md bg-black/[0.05] p-0.5 dark:bg-white/[0.06] border">
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
                      icon={Upload}
                      label="Import session"
                      onClick={handleImport}
                    />
                    <NavRow
                      icon={Zap}
                      label="Routines"
                      active={view === "routines"}
                      onClick={() =>
                        setView((v) => (v === "routines" ? "chat" : "routines"))
                      }
                    />
                  </div>

                  <RoutinesList
                    onOpen={openChatById}
                    currentSessionId={currentSessionId}
                    onDelete={handleDeleteSession}
                    onRename={(id, title) => {
                      setRenameTargetId(id);
                      setRenameValue(title);
                      setRenameOpen(true);
                    }}
                    onFork={forkSession}
                    space={appMode}
                  />

                  <div className="flex min-h-0 flex-1 flex-col px-2">
                    <div className="flex items-center justify-between px-2 pb-1 pt-3">
                      <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                        Recents
                      </span>
                      <FilterDropdown filters={filters} onChange={setFilters} />
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <SessionList
                        onSelect={handleSelectSession}
                        onDelete={handleDeleteSession}
                        onRename={(id, title) => {
                          setRenameTargetId(id);
                          setRenameValue(title);
                          setRenameOpen(true);
                        }}
                        onFork={forkSession}
                        currentSessionId={currentSessionId}
                        space={appMode}
                        filters={filters}
                      />
                    </div>
                  </div>

                  <div className="p-2">
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
              // Home: a plain, centered chat. It CAN open the Artifacts/Files
              // panel on the right, and — when the sandbox engine has a shell
              // (Podman/subprocess) — a Sandbox terminal below that runs inside
              // this chat's sandbox (never the host).
              <ResizablePanelGroup direction="horizontal" className="gap-1">
                <ResizablePanel minSize={30}>
                  <ResizablePanelGroup direction="vertical" className="gap-1">
                    <ResizablePanel minSize={20}>
                      <div className="h-full min-h-0 overflow-hidden relative">
                        {view === "routines" ? (
                          <div className="h-full overflow-auto">
                            <div className="mx-auto max-w-4xl px-6 py-8">
                              <RoutinesSettings />
                            </div>
                          </div>
                        ) : (
                          <ChatView
                            transcriptMode={transcriptMode}
                            sessionTitle={sessionTitle}
                            home
                            onOpenSettings={() => {
                              setSettingsSection("sandbox");
                              setSettingsOpen(true);
                        }}
                        onOpenProvidersSettings={() => {
                          setSettingsSection("providers");
                          setSettingsOpen(true);
                        }}
                      />
                    )}
                    {viewer && (
                      <div className="!absolute inset-0 z-10">
                        <ViewerErrorBoundary
                          key={`viewer:${viewer.path ?? viewer.name}`}
                          onClose={closeViewer}
                        >
                          <FileViewer
                            path={viewer.source === "file" ? viewer.path : undefined}
                            item={viewer.source !== "file" ? viewer : undefined}
                            onClose={closeViewer}
                          />
                        </ViewerErrorBoundary>
                      </div>
                    )}
                        {expandedSubAgent && (
                          <div className="!absolute inset-0 z-10 flex h-full flex-col glass-panel rounded-xl border border-border bg-card overflow-hidden">
                            <div className="relative shrink-0 border-b border-border px-4 py-3">
                              <div className="mx-auto max-w-3xl flex items-center gap-2">
                                <span className="text-sm font-medium text-foreground">Sub-agent</span>
                                <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-400">
                                  {expandedSubAgent.agentType}
                                </span>
                                {expandedSubAgent.description && (
                                  <span className="text-xs text-muted-foreground">{expandedSubAgent.description}</span>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={closeExpandedSubAgent}
                                title="Back to chat"
                                className="absolute right-4 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
                              >
                                <X className="size-4" />
                              </button>
                            </div>
                            <div className="flex-1 overflow-y-auto px-4 py-3">
                              <div className="mx-auto max-w-3xl">
                                <SubAgentTranscript
                                  messages={expandedSubAgent.messages}
                                  running={expandedSubAgent.status === "running"}
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </ResizablePanel>
                    {terminalOpen && homeShellSupported && (
                      <>
                        <ResizableHandle withHandle />
                        <ResizablePanel defaultSize={32} minSize={12}>
                          <Panel>
                            <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                              <span className="text-xs font-medium text-muted-foreground">
                                Sandbox terminal
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
                              <Terminal
                                runner={sandboxRunner}
                                intro={[
                                  "Home sandbox — commands run inside this chat's sandbox, not on your machine.",
                                  "Files you create show up in the Files panel. Shell state (cwd, env) resets each command.",
                                ]}
                              />
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
                      defaultSize={30}
                      minSize={18}
                      maxSize={55}
                    >
                      <div className="glass-panel flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
                        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
                          <button
                            type="button"
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
                            type="button"
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
                            <SandboxFilesPanel />
                          ) : (
                            <ArtifactsPanel />
                          )}
                        </div>
                      </div>
                    </ResizablePanel>
                  </>
                )}
              </ResizablePanelGroup>
            ) : (
              <ResizablePanelGroup direction="horizontal" className="gap-1">
                <ResizablePanel defaultSize={72} minSize={25}>
                  <ResizablePanelGroup direction="vertical" className="gap-1">
                    <ResizablePanel minSize={20}>
                      <div className="flex h-full min-h-0 flex-col overflow-hidden relative">
                        {view === "chat" && (
                          <ChatView
                            transcriptMode={transcriptMode}
                            sessionTitle={sessionTitle}
                            onOpenProvidersSettings={() => {
                              setSettingsSection("providers");
                              setSettingsOpen(true);
                            }}
                          />
                        )}
                        {view === "skills" && (
                          <div className="h-full overflow-auto">
                            <SkillsPanel />
                          </div>
                        )}
                        {view === "routines" && (
                          <div className="h-full overflow-auto">
                            <div className="mx-auto max-w-4xl px-6 py-8">
                              <RoutinesSettings onOpenChat={openChatById} />
                            </div>
                          </div>
                        )}
                        {viewer && (
                          <div className="!absolute inset-0 z-10">
                            <ViewerErrorBoundary
                              key={`viewer:${viewer.path ?? viewer.name}`}
                              onClose={closeViewer}
                            >
                              <FileViewer
                                path={viewer.source === "file" ? viewer.path : undefined}
                                item={viewer.source !== "file" ? viewer : undefined}
                                onClose={closeViewer}
                              />
                            </ViewerErrorBoundary>
                          </div>
                        )}
                        {expandedSubAgent && (
                          <div className="!absolute inset-0 z-10 flex h-full flex-col glass-panel rounded-xl border border-border bg-card overflow-hidden">
                            <div className="relative shrink-0 border-b border-border px-4 py-3">
                              <div className="mx-auto max-w-3xl flex items-center gap-2">
                                <span className="text-sm font-medium text-foreground">Sub-agent</span>
                                <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-400">
                                  {expandedSubAgent.agentType}
                                </span>
                                {expandedSubAgent.description && (
                                  <span className="text-xs text-muted-foreground">{expandedSubAgent.description}</span>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={closeExpandedSubAgent}
                                title="Back to chat"
                                className="absolute right-4 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
                              >
                                <X className="size-4" />
                              </button>
                            </div>
                            <div className="flex-1 overflow-y-auto px-4 py-3">
                              <div className="mx-auto max-w-3xl">
                                <SubAgentTranscript
                                  messages={expandedSubAgent.messages}
                                  running={expandedSubAgent.status === "running"}
                                />
                              </div>
                            </div>
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
                          <button
                            onClick={() => setRightTab("changes")}
                            className={cn(
                              "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                              rightTab === "changes"
                                ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            Changes
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
                            <FileTree
                              onSelectFile={(p) => {
                                useChatStore.getState().openViewer({
                                  name: p.split(/[/\\]/).pop() || p,
                                  path: p,
                                  mediaType: "application/octet-stream",
                                  kind: "file",
                                  source: "file",
                                });
                              }}
                            />
                          </div>
                          <div
                            className={rightTab === "artifacts" ? "" : "hidden"}
                          >
                            <ArtifactsPanel />
                          </div>
                          {rightTab === "changes" && <ChangesPanel />}
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
        <SettingsPanel
          theme={theme}
          setTheme={setTheme}
          initialSection={settingsSection}
        />
      </Modal>

      <Modal
        open={incognitoCloseOpen}
        onClose={() => setIncognitoCloseOpen(false)}
        title={
          <div className="flex items-center gap-2">
            <Ghost className="size-4 text-muted-foreground" />
            <h3 className="text-base font-semibold">Close incognito chat?</h3>
          </div>
        }
      >
        <p>
          Everything from this chat will be deleted permanently — the
          conversation, sandbox files and generated artifacts. If you need a
          file, download it before closing.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setIncognitoCloseOpen(false)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={closeIncognito}
            className="rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90"
          >
            Close & delete
          </button>
        </div>
      </Modal>

      <Modal
        open={deleteConfirmId !== null}
        onClose={() => setDeleteConfirmId(null)}
        title="Delete chat"
      >
        <p className="text-sm text-muted-foreground">
          Are you sure you want to delete this chat? This action cannot be undone.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setDeleteConfirmId(null)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              const id = deleteConfirmId;
              setDeleteConfirmId(null);
              if (id) void handleDeleteSession(id);
            }}
            className="rounded-lg bg-red-text px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Delete
          </button>
        </div>
      </Modal>

      <Modal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title="Rename chat"
      >
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleRename();
            if (e.key === "Escape") setRenameOpen(false);
          }}
          placeholder="Chat name"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground/20"
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
      </Modal>

      <PermissionHost />
      </div>
    </div>
  );
}
