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
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-core/dist/styles/dockview.css";
import "./dock.css";
import { Maximize2, Minimize2, PictureInPicture2, PanelRight } from "lucide-react";
import { ArtifactsPanel } from "@/components/ArtifactsPanel";
import { ChangesPanel } from "@/components/ChangesPanel";
import { SandboxFilesPanel } from "@/components/SandboxFilesPanel";
import { BackgroundTasksPanel } from "@/components/BackgroundTasks";
import { FileTree } from "@/components/FileTree";
import { BrowserPanel } from "@/components/browser/BrowserPanel";
import { useBrowserStore } from "@/components/browser/browser-store";
import { useChatStore } from "@/stores/chatStore";
import { useDockStore } from "./dock-store";

const Terminal = lazy(() =>
  import("@/components/Terminal").then((m) => ({ default: m.Terminal })),
);

/** What the panels need from App, delivered without remounting them. */
export interface DockAreaContext {
  space: "home" | "code";
  currentSessionId?: string;
  openBackgroundTask: (id: string) => void;
  sandboxRunner: (
    command: string,
  ) => Promise<{ output?: string; error?: string }>;
}

let latest: DockAreaContext = {
  space: "code",
  openBackgroundTask: () => {},
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

const scrollWrap = (children: ReactNode): JSX.Element => (
  <div className="h-full min-h-0 overflow-auto bg-card">
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
  files: function FilesDockPanel() {
    const sessionId = useChatStore((s) => s.currentSessionId);
    void sessionId;
    if (latest.space === "home") return scrollWrap(<SandboxFilesPanel />);
    return scrollWrap(
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
      />,
    );
  },
  artifacts: function ArtifactsDockPanel() {
    return scrollWrap(<ArtifactsPanel />);
  },
  changes: function ChangesDockPanel() {
    return scrollWrap(<ChangesPanel />);
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
      <div className="relative h-full min-h-0 overflow-hidden bg-card">
        <PanelBoundary>
          <BrowserPanel />
        </PanelBoundary>
      </div>
    );
  },
  terminal: function TerminalDockPanel() {
    const home = latest.space === "home";
    return (
      <div className="h-full min-h-0 bg-card">
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

/** Float / dock-back / maximize — the group's own controls, app-styled. */
function GroupActions(props: IDockviewHeaderActionsProps): JSX.Element {
  const { group, containerApi } = props;
  const [floating, setFloating] = useState(group.api.location.type === "floating");
  const [maximized, setMaximized] = useState(group.api.isMaximized());

  useEffect(() => {
    const d1 = group.api.onDidLocationChange((e) =>
      setFloating(e.location.type === "floating"),
    );
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
      <button
        type="button"
        title={floating ? "Dock back into the panel" : "Detach as floating window"}
        className={btn}
        onClick={() => {
          if (floating) group.api.moveTo({ position: "right" });
          else
            containerApi.addFloatingGroup(group, {
              position: { top: 48, right: 48 },
              width: 560,
              height: 420,
            });
        }}
      >
        {floating ? (
          <PanelRight className="size-3.5" />
        ) : (
          <PictureInPicture2 className="size-3.5" />
        )}
      </button>
    </div>
  );
}

function Watermark(): JSX.Element {
  return <div className="h-full bg-card" />;
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

  const onReady = useMemo(
    () =>
      (event: DockviewReadyEvent): void => {
        const { api } = event;
        useDockStore.getState().setApi(api);
        const sync = (): void => useDockStore.getState().syncFromApi();
        api.onDidLayoutChange(sync);
        api.onDidAddPanel(sync);
        api.onDidRemovePanel(sync);
      },
    [],
  );

  useEffect(() => () => useDockStore.getState().setApi(null), []);

  return (
    <DockviewReact
      className={`${dark ? "dockview-theme-dark" : "dockview-theme-light"} monet-dock`}
      components={components}
      onReady={onReady}
      rightHeaderActionsComponent={GroupActions}
      watermarkComponent={Watermark}
      floatingGroupBounds="boundedWithinViewport"
      disableDnd={false}
    />
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
