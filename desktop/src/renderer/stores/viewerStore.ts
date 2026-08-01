/**
 * Viewer panes — several viewer windows at once, each with its own tabs and
 * VS Code's preview idiom inside each.
 *
 * A PANE is a dock panel ("viewer", "viewer:2", …); the user splits new ones
 * off from the tab strip and arranges them like any other panel. Files open
 * into the ACTIVE pane — the one last interacted with — as a PREVIEW tab
 * (italic; the next single click reuses it). Clicking the tab, double-click,
 * or the pin promotes it; walking the tree never sheds tabs.
 *
 * The whole arrangement is serialized into the session's ui-state (like the
 * dock layout and browser tabs), so a chat comes back with its files open.
 *
 * chatStore keeps its `openViewer(item)` facade — every "open a file" click
 * in the app lands here through it.
 */

import { create } from "zustand";

export interface ViewerFile {
  name: string;
  path?: string;
  mediaType: string;
  kind: string;
  dataUrl?: string;
  source?: "artifact" | "file";
}

export interface ViewerTab {
  /** Stable per tab (React key) — survives the preview tab changing files. */
  id: string;
  file: ViewerFile;
  /** Italic title; the next preview open replaces this tab's file. */
  preview: boolean;
}

export interface ViewerPane {
  /** Doubles as the dock panel id: "viewer", "viewer:2", … */
  id: string;
  tabs: ViewerTab[];
  activeId: string | null;
}

/** What ui-state stores per session. */
export interface ViewerPaneSnapshot {
  tabs: { file: ViewerFile; preview: boolean }[];
  active: number;
}

/** Two entries are "the same file" if they resolve to the same thing. */
function sameFile(a: ViewerFile, b: ViewerFile): boolean {
  if (a.path && b.path) return a.path === b.path && a.source === b.source;
  return a.name === b.name && a.source === b.source && !a.path === !b.path;
}

let tabSeq = 0;
const nextTabId = (): string => `vtab-${++tabSeq}`;
let paneSeq = 1;
const nextPaneId = (): string => `viewer:${++paneSeq}`;

interface ViewerState {
  panes: ViewerPane[];
  activePaneId: string | null;
  /** Open a file in the active pane. preview=true (default) is the VS Code
   * idiom; preview=false opens (or promotes to) a permanent tab. */
  open: (file: ViewerFile, opts?: { preview?: boolean }) => void;
  /** A fresh empty pane beside the others; it becomes the active one. */
  split: () => void;
  setActivePane: (paneId: string) => void;
  promote: (paneId: string, tabId: string) => void;
  activateTab: (paneId: string, tabId: string) => void;
  closeTab: (paneId: string, tabId: string) => void;
  /** The dock panel was closed — the whole pane goes. */
  closePane: (paneId: string) => void;
  closeAll: () => void;
  /** ui-state round-trip. */
  serialize: () => ViewerPaneSnapshot[];
  restore: (snap: ViewerPaneSnapshot[] | undefined) => void;
}

function updatePane(
  panes: ViewerPane[],
  paneId: string,
  fn: (p: ViewerPane) => ViewerPane,
): ViewerPane[] {
  return panes.map((p) => (p.id === paneId ? fn(p) : p));
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  panes: [],
  activePaneId: null,

  open: (file, opts) => {
    const preview = opts?.preview !== false;
    const { panes, activePaneId } = get();
    let pane = panes.find((p) => p.id === activePaneId) ?? panes[0];
    if (!pane) {
      pane = { id: "viewer", tabs: [], activeId: null };
      set({ panes: [pane], activePaneId: pane.id });
    }
    const paneId = pane.id;
    const existing = pane.tabs.find((t) => sameFile(t.file, file));
    if (existing) {
      set((s) => ({
        activePaneId: paneId,
        panes: updatePane(s.panes, paneId, (p) => ({
          ...p,
          activeId: existing.id,
          // Re-opening a preview as permanent pins it; never the reverse.
          tabs: preview
            ? p.tabs
            : p.tabs.map((t) =>
                t.id === existing.id ? { ...t, preview: false } : t,
              ),
        })),
      }));
      return;
    }
    if (preview) {
      const pv = pane.tabs.find((t) => t.preview);
      if (pv) {
        set((s) => ({
          activePaneId: paneId,
          panes: updatePane(s.panes, paneId, (p) => ({
            ...p,
            activeId: pv.id,
            tabs: p.tabs.map((t) => (t.id === pv.id ? { ...t, file } : t)),
          })),
        }));
        return;
      }
    }
    const tab: ViewerTab = { id: nextTabId(), file, preview };
    set((s) => ({
      activePaneId: paneId,
      panes: updatePane(s.panes, paneId, (p) => ({
        ...p,
        tabs: [...p.tabs, tab],
        activeId: tab.id,
      })),
    }));
  },

  split: () => {
    const pane: ViewerPane = { id: nextPaneId(), tabs: [], activeId: null };
    set((s) => ({ panes: [...s.panes, pane], activePaneId: pane.id }));
  },

  setActivePane: (paneId) => set({ activePaneId: paneId }),

  promote: (paneId, tabId) =>
    set((s) => ({
      activePaneId: paneId,
      panes: updatePane(s.panes, paneId, (p) => ({
        ...p,
        tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, preview: false } : t)),
      })),
    })),

  activateTab: (paneId, tabId) =>
    set((s) => ({
      activePaneId: paneId,
      panes: updatePane(s.panes, paneId, (p) => ({ ...p, activeId: tabId })),
    })),

  closeTab: (paneId, tabId) =>
    set((s) => {
      let panes = updatePane(s.panes, paneId, (p) => {
        const idx = p.tabs.findIndex((t) => t.id === tabId);
        const tabs = p.tabs.filter((t) => t.id !== tabId);
        return {
          ...p,
          tabs,
          activeId:
            p.activeId === tabId
              ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null)
              : p.activeId,
        };
      });
      // An emptied pane closes — except the last one, which just shows the
      // empty state (matching the dock's viewer panel lifecycle).
      const emptied = panes.find((p) => p.id === paneId && p.tabs.length === 0);
      if (emptied && panes.length > 1)
        panes = panes.filter((p) => p.id !== paneId);
      const activePaneId = panes.some((p) => p.id === s.activePaneId)
        ? s.activePaneId
        : (panes[0]?.id ?? null);
      return { panes, activePaneId };
    }),

  closePane: (paneId) =>
    set((s) => {
      const panes = s.panes.filter((p) => p.id !== paneId);
      return {
        panes,
        activePaneId:
          s.activePaneId === paneId ? (panes[0]?.id ?? null) : s.activePaneId,
      };
    }),

  closeAll: () => set({ panes: [], activePaneId: null }),

  serialize: () =>
    get().panes.map((p) => ({
      tabs: p.tabs.map((t) => ({ file: t.file, preview: t.preview })),
      active: Math.max(
        0,
        p.tabs.findIndex((t) => t.id === p.activeId),
      ),
    })),

  restore: (snap) => {
    if (!snap || snap.length === 0) {
      set({ panes: [], activePaneId: null });
      return;
    }
    const panes: ViewerPane[] = snap
      .filter((p) => Array.isArray(p.tabs))
      .map((p, i) => {
        const tabs: ViewerTab[] = p.tabs
          .filter((t) => t && t.file && typeof t.file.name === "string")
          .map((t) => ({ id: nextTabId(), file: t.file, preview: !!t.preview }));
        return {
          id: i === 0 ? "viewer" : nextPaneId(),
          tabs,
          activeId: tabs[Math.min(p.active ?? 0, tabs.length - 1)]?.id ?? null,
        };
      })
      .filter((p) => p.tabs.length > 0);
    set({ panes, activePaneId: panes[0]?.id ?? null });
  },
}));
