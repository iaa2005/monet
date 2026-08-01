/**
 * The wing as a dock: every panel draggable, splittable, stackable, floatable.
 *
 * dockview owns the geometry; this file owns two contracts around it:
 *
 * 1. The BROWSER panel's content must keep compositing while hidden behind
 *    another tab — a <webview> whose container goes display:none stops
 *    producing frames (measured in webview-probe). The panel is therefore
 *    added with renderer:'always', which dockview hides with `visibility`
 *    instead. Dragging the panel to a new group still re-attaches the
 *    guests (a DOM move destroys them); BrowserView re-registers on
 *    dom-ready and reloads the tab's current URL, so the cost of a drag is
 *    a reload, not a lost tab.
 *
 * 2. The components map is created ONCE. dockview treats a new map as a new
 *    world; App-level state reaches the panels through a ref instead, so a
 *    re-render never remounts a panel (and never reloads the browser).
 */

import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-core/dist/styles/dockview.css";
import "./dock.css";
import {
  ExternalLink,
  Maximize2,
  Minimize2,
  PanelRight,
  X,
} from "lucide-react";
import { ArtifactsPanel } from "@/components/ArtifactsPanel";
import { ChangesPanel } from "@/components/ChangesPanel";
import { SandboxFilesPanel } from "@/components/SandboxFilesPanel";
import { BackgroundTasksPanel } from "@/components/BackgroundTasks";
import { RoutinesSettings } from "@/components/settings/RoutinesSettings";
import { PlanPanel } from "@/components/PlanPanel";
import { FileTree } from "@/components/FileTree";
import { FileViewer } from "@/components/FileViewer";
import { ViewerErrorBoundary } from "@/components/ViewerErrorBoundary";
import { BrowserPanel } from "@/components/browser/BrowserPanel";
import { useBrowserStore } from "@/components/browser/browser-store";
import { useViewerStore } from "@/stores/viewerStore";
import { fallbackIcon, resolveIcon } from "@/components/icon-resolver";
import { closeViewerPane, openViewerPane } from "@/dock/dock-store";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { isApplyingDesk, useDockStore } from "./dock-store";

const Terminal = lazy(() =>
  import("@/components/Terminal").then((m) => ({ default: m.Terminal })),
);

/** What the panels need from App, delivered without remounting them. */
export interface DockAreaContext {
  space: "home" | "code";
  currentSessionId?: string;
  openBackgroundTask: (id: string) => void;
  /** Open a chat by id — routines link to the sessions they started. */
  openChat: (id: string) => void;
  sandboxRunner: (
    command: string,
  ) => Promise<{ output?: string; error?: string }>;
}

let latest: DockAreaContext = {
  space: "code",
  openBackgroundTask: () => {},
  openChat: () => {},
  sandboxRunner: async () => ({ error: "not ready" }),
};

/** A panel that crashes stays a broken tab, not a broken desk. */
class PanelBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  render(): ReactNode {
    if (this.state.error)
      return (
        <div className="p-4 text-xs text-muted-foreground">
          This panel crashed: {this.state.error.message}
        </div>
      );
    return this.props.children;
  }
}

// No background of its own: the group card paints it, and under the Monet
// backdrop the card is GLASS — an opaque wrapper here would blind it.
const scrollWrap = (children: ReactNode): JSX.Element => (
  <div className="h-full min-h-0 overflow-auto">
    <PanelBoundary>{children}</PanelBoundary>
  </div>
);

/**
 * One components map for the lifetime of the module — see note 2 above.
 * Session-dependent panels re-read `latest` on every render pass of their
 * own; a session switch re-renders them through the store subscriptions
 * they already hold.
 */
const components: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  /**
   * The chat. Just a host div — App PORTALS the whole conversation column
   * into it (see dock-store.mainHost), so streams, drafts and viewers live
   * in App's tree and survive any dock rearrangement.
   */
  main: function MainDockPanel() {
    return (
      <div
        className="h-full min-h-0 overflow-hidden"
        ref={(el) => useDockStore.getState().setMainHost(el)}
      />
    );
  },
  /**
   * The file preview — a panel like any other, so a document can sit beside
   * the conversation, stack with Files, or float in its own window.
   *
   * It follows chatStore.viewer rather than owning it: the same click that
   * opens a file from a tool result, the file tree or an artifact lands here.
   * The `key` remounts on a new file, which is what makes a broken preview
   * recoverable by simply opening something else.
   */
  viewer: function ViewerDockPanel(props: IDockviewPanelProps) {
    // One file, one card. The dock's own tab names it — there is no second
    // strip inside, which is what made the header two rows deep.
    const id = props.api.id;
    const doc = useViewerStore((s) => s.docs.find((d) => d.id === id));
    if (!doc)
      return (
        <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
          Open a file to preview it here.
        </div>
      );
    const close = (): void => useViewerStore.getState().close(id);
    return (
      <div
        className="h-full min-h-0 overflow-hidden"
        onMouseDownCapture={() => useViewerStore.getState().setActive(id)}
      >
        <ViewerErrorBoundary
          key={`${id}:${doc.file.path ?? doc.file.name}`}
          onClose={close}
        >
          <FileViewer
            path={doc.file.source === "file" ? doc.file.path : undefined}
            item={doc.file.source !== "file" ? doc.file : undefined}
            docId={id}
            onClose={close}
          />
        </ViewerErrorBoundary>
      </div>
    );
  },
  files: function FilesDockPanel() {
    const sessionId = useChatStore((s) => s.currentSessionId);
    void sessionId;
    if (latest.space === "home") return scrollWrap(<SandboxFilesPanel />);
    // Click previews, double click keeps — VS Code's idiom, both halves.
    const asFile = (p: string) => ({
      name: p.split(/[/\\]/).pop() || p,
      path: p,
      mediaType: "application/octet-stream",
      kind: "file",
      source: "file" as const,
    });
    return scrollWrap(
      <FileTree
        onSelectFile={(p) => useChatStore.getState().openViewer(asFile(p))}
        onOpenFile={(p) =>
          useChatStore.getState().openViewer(asFile(p), { preview: false })
        }
      />,
    );
  },
  artifacts: function ArtifactsDockPanel() {
    return scrollWrap(<ArtifactsPanel />);
  },
  changes: function ChangesDockPanel() {
    return scrollWrap(<ChangesPanel />);
  },
  /**
   * Scheduled runs. A panel rather than a takeover of the chat: reading a
   * routine's history while the conversation that triggered it is right
   * there is the whole point.
   */
  routines: function RoutinesDockPanel() {
    return scrollWrap(
      <div className="px-4 py-4">
        <RoutinesSettings onOpenChat={(id) => latest.openChat(id)} />
      </div>,
    );
  },
  plan: function PlanDockPanel() {
    return scrollWrap(<PlanPanel />);
  },
  tasks: function TasksDockPanel() {
    const sessionId = useChatStore((s) => s.currentSessionId);
    return scrollWrap(
      <BackgroundTasksPanel
        onOpen={(id) => latest.openBackgroundTask(id)}
        currentSessionId={sessionId}
      />,
    );
  },
  browser: function BrowserDockPanel() {
    return (
      <div className="relative h-full min-h-0 overflow-hidden">
        <PanelBoundary>
          <BrowserPanel />
        </PanelBoundary>
      </div>
    );
  },
  terminal: function TerminalDockPanel() {
    const home = latest.space === "home";
    return (
      <div className="h-full min-h-0">
        <PanelBoundary>
          <Suspense
            fallback={
              <div className="p-3 text-xs text-muted-foreground">
                Loading terminal…
              </div>
            }
          >
            {home ? (
              <Terminal
                runner={(cmd: string) => latest.sandboxRunner(cmd)}
                intro={[
                  "Home sandbox — commands run inside this chat's sandbox, not on your machine.",
                  "Files you create show up in the Files panel. Shell state (cwd, env) resets each command.",
                ]}
              />
            ) : (
              <Terminal />
            )}
          </Suspense>
        </PanelBoundary>
      </div>
    );
  },
};

/** The popout host page, resolved beside whatever document we are in —
 * works for the dev server (http) and the packaged build (file:) alike. */
const popoutUrl = (): string => new URL("popout.html", location.href).toString();

/**
 * Make a popout window wear the app's skin.
 *
 * dockview copies every stylesheet into the popout document, but the theme
 * lives one level higher: the `dark` class on the ROOT element is what picks
 * which token values those stylesheets resolve to. Without it a popout came
 * out half-and-half — dark dockview chrome over light-token content. The
 * classes are mirrored on open and kept in sync while the window lives, so
 * toggling the theme re-dresses every popout too.
 *
 * `monet-glass` is deliberately dropped: the painted backdrop lives in the
 * main window, and glass over nothing is a white sheet.
 */
function dressPopout(w: Window): void {
  // NOT unload-based cleanup: window.open starts on about:blank and the
  // navigation to popout.html fires an unload of its own — an observer
  // disconnected there went deaf before the window even finished opening
  // (caught by the click probe: theme changes never reached the popout).
  const obs = new MutationObserver(() => sync());
  const sync = (): void => {
    if (w.closed) {
      obs.disconnect();
      return;
    }
    try {
      w.document.documentElement.className = document.documentElement.className
        .split(/\s+/)
        .filter((c) => c && c !== "monet-glass")
        .join(" ");
      w.document.body.style.background = "var(--background)";
    } catch {
      /* mid-navigation; the load listener below runs it again */
    }
  };
  // Once now, and again on load — the navigation replaces the document this
  // first call ran against.
  sync();
  w.addEventListener("load", sync);
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

/** Maximize / detach-to-OS-window / dock-back — the group's own controls. */
function GroupActions(props: IDockviewHeaderActionsProps): JSX.Element {
  const { group, containerApi } = props;
  const [location, setLocation] = useState(group.api.location.type);
  const [maximized, setMaximized] = useState(group.api.isMaximized());
  // The chat anchors the grid: it can move within it, but not leave it.
  const holdsMain = props.panels.some((p) => p.id === "main");

  useEffect(() => {
    const d1 = group.api.onDidLocationChange((e) => setLocation(e.location.type));
    const d2 = containerApi.onDidMaximizedGroupChange(() =>
      setMaximized(group.api.isMaximized()),
    );
    return () => {
      d1.dispose();
      d2.dispose();
    };
  }, [group, containerApi]);

  const btn =
    "flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]";

  return (
    <div className="flex h-full items-center gap-0.5 px-1">
      {location === "grid" && (
        <button
          type="button"
          title={maximized ? "Restore size" : "Maximize"}
          className={btn}
          onClick={() => {
            if (maximized) containerApi.exitMaximizedGroup();
            else group.api.maximize();
          }}
        >
          {maximized ? (
            <Minimize2 className="size-3.5" />
          ) : (
            <Maximize2 className="size-3.5" />
          )}
        </button>
      )}
      {location !== "grid" && (
        <button
          type="button"
          title="Dock back into the window"
          className={btn}
          onClick={() => group.api.moveTo({ position: "right" })}
        >
          <PanelRight className="size-3.5" />
        </button>
      )}
      {!holdsMain && location !== "popout" && (
        <button
          type="button"
          title="Detach into its own window"
          className={btn}
          onClick={() =>
            void containerApi.addPopoutGroup(group, {
              popoutUrl: popoutUrl(),
              onDidOpen: ({ window: w }) => dressPopout(w),
            })
          }
        >
          <ExternalLink className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * The tab, app-styled — and the reason it is custom at all: the chat panel
 * gets NO close button. The conversation is the dock's anchor; every other
 * panel closes like a tab anywhere else.
 *
 * The title is SUBSCRIBED, not read once. dockview's own tab does this and
 * a custom one has to as well: the viewer renames itself for every file it
 * opens, and a plain `props.api.title` read froze the tab on the first
 * file's name — reported from use.
 */
function DockTab(props: IDockviewPanelHeaderProps): JSX.Element {
  const closable = props.api.id !== "main";
  const [title, setTitle] = useState(props.api.title);
  useEffect(() => {
    setTitle(props.api.title);
    const d = props.api.onDidTitleChange((e) => setTitle(e.title));
    return () => d.dispose();
  }, [props.api]);

  // A file card wears its type's icon — the same flow pack the tree uses, so
  // a file looks the same wherever the app shows it. And while the card is a
  // PREVIEW its name is italic: VS Code's idiom, and the only warning that
  // the next single click replaces this card instead of adding one. Double
  // -clicking the tab pins it, exactly as it does there.
  const doc = useViewerStore((s) => s.docs.find((d) => d.id === props.api.id));
  const dark = useIsDark();
  return (
    <div
      className="flex h-full items-center gap-1.5 px-0 text-xs font-medium"
      onDoubleClick={() => {
        if (doc?.preview) useViewerStore.getState().pin(doc.id);
      }}
    >
      {doc && (
        <img
          src={resolveIcon(doc.file.name, false, false, dark)}
          className="size-3.5 shrink-0"
          alt=""
          onError={(e) => {
            const img = e.currentTarget;
            const fb = fallbackIcon(false, false, dark);
            if (!img.src.endsWith(fb)) img.src = fb;
          }}
        />
      )}
      <span
        className={doc?.preview ? "truncate italic" : "truncate"}
        title={title}
      >
        {title}
      </span>
      {doc?.dirty && (
        <span
          title="Unsaved changes"
          className="size-1.5 shrink-0 rounded-full bg-brand"
        />
      )}
      {closable && (
        <button
          type="button"
          aria-label="Close panel"
          className="dv-default-tab-action -mr-1 flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-black/[0.08] hover:text-foreground dark:hover:bg-white/[0.10]"
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            props.api.close();
          }}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

function Watermark(): JSX.Element {
  return <div className="h-full" />;
}

export function DockArea(ctx: DockAreaContext): JSX.Element {
  latest = ctx;
  const dark = useIsDark();

  // The browser's own expand button maximizes its group — the dock's native
  // version of "this page needs the room".
  const browserLayout = useBrowserStore((s) => s.layout);
  useEffect(() => {
    const api = useDockStore.getState().api;
    const panel = api?.getPanel("browser");
    if (!api || !panel) return;
    if (browserLayout === "expanded") api.maximizeGroup(panel);
    else if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
  }, [browserLayout]);

  // The file preview and its panel are one thing seen twice: a file opened
  // anywhere in the app raises the panel and names its tab; closing the
  // panel's tab clears the file. Without the second half the panel would
  // reopen the instant it was closed.
  const viewerDocs = useViewerStore((s) => s.docs);
  const viewerOpen = useDockStore((s) => s.open.includes("viewer"));
  useEffect(() => {
    const dock = useDockStore.getState();
    // Every open file gets (or keeps) its card, named after the file; a file
    // that was closed takes its card with it.
    for (const doc of viewerDocs) {
      openViewerPane(doc.id);
      const panel = dock.api?.getPanel(doc.id);
      if (panel && panel.title !== doc.file.name)
        panel.api.setTitle(doc.file.name);
    }
    const wanted = new Set(viewerDocs.map((d) => d.id));
    for (const panel of dock.api?.panels ?? [])
      if (/^viewer(:\d+)?$/.test(panel.id) && !wanted.has(panel.id))
        closeViewerPane(panel.id);
    if (viewerDocs.length === 0 && viewerOpen) dock.closePanel("viewer");
  }, [viewerDocs, viewerOpen]);

  const onReady = useMemo(
    () =>
      (event: DockviewReadyEvent): void => {
        const { api } = event;
        useDockStore.getState().setApi(api);
        const sync = (): void => useDockStore.getState().syncFromApi();
        api.onDidLayoutChange(sync);
        api.onDidAddPanel(sync);
        api.onDidRemovePanel((panel) => {
          sync();
          // Closing the tab IS closing the file — but only when a person did
          // it. A desk restore removes every panel on its way through, and
          // reading that as a close would drop the open file on every switch.
          if (/^viewer(:\d+)?$/.test(panel.id) && !isApplyingDesk())
            useViewerStore.getState().close(panel.id);
        });
      },
    [],
  );

  useEffect(() => () => useDockStore.getState().setApi(null), []);

  // One continuous grid: no gap between groups, so the hairline BETWEEN two
  // panels is a single shared border — and that border is the sash you grab
  // to resize (see dock.css). Denser, and nothing to align.
  const theme: DockviewTheme = useMemo(
    () => ({
      name: "monet",
      className: `${dark ? "dockview-theme-dark" : "dockview-theme-light"} monet-dock`,
      colorScheme: dark ? "dark" : "light",
      gap: 0,
    }),
    [dark],
  );

  // dockview ships NO height of its own — it measures its container. h-full,
  // not flex-1: the host is a bare ResizablePanel div, not a flex column, and
  // flex-1 outside a flex parent is how the dock booted 100px tall.
  return (
    <div className="h-full min-h-0 w-full">
      <DockviewReact
        className="h-full w-full"
        theme={theme}
        components={components}
        onReady={onReady}
        defaultTabComponent={DockTab}
        rightHeaderActionsComponent={GroupActions}
        watermarkComponent={Watermark}
        floatingGroupBounds="boundedWithinViewport"
        disableDnd={false}
      />
    </div>
  );
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.classList.contains("dark")));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}
