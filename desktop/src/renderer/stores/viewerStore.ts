/**
 * Viewer tabs — several files open at once, with VS Code's preview idiom.
 *
 * The viewer used to hold ONE file: opening the next replaced it. Now it
 * holds a tab strip. A single click in the tree (or a tool-result link, or
 * an artifact card) opens the file as a PREVIEW — italic title, and the next
 * single click reuses that same tab, so walking through a tree does not
 * shed tabs everywhere. Clicking the tab itself, double-clicking in the
 * tree, or the pin button PROMOTES it to a real tab; after that it stays.
 *
 * chatStore keeps its `openViewer(item)` facade (a dozen call sites feed it:
 * tool links, artifact cards, the file tree) — it lands here.
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

/** Two entries are "the same file" if they resolve to the same thing. */
function sameFile(a: ViewerFile, b: ViewerFile): boolean {
  if (a.path && b.path) return a.path === b.path && a.source === b.source;
  return a.name === b.name && a.source === b.source && !a.path === !b.path;
}

let seq = 0;
const nextId = (): string => `vtab-${++seq}`;

interface ViewerState {
  tabs: ViewerTab[];
  activeId: string | null;
  /** Open a file. preview=true (the default) follows the VS Code idiom;
   * preview=false opens (or promotes to) a permanent tab. */
  open: (file: ViewerFile, opts?: { preview?: boolean }) => void;
  /** Make a preview tab permanent (tab click / pin button / tree dblclick). */
  promote: (id: string) => void;
  activate: (id: string) => void;
  close: (id: string) => void;
  closeAll: () => void;
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  tabs: [],
  activeId: null,

  open: (file, opts) => {
    const preview = opts?.preview !== false;
    const { tabs } = get();
    const existing = tabs.find((t) => sameFile(t.file, file));
    if (existing) {
      set({
        activeId: existing.id,
        // Re-opening a preview as permanent pins it; the reverse never
        // demotes — a pinned tab stays pinned.
        tabs: preview
          ? tabs
          : tabs.map((t) =>
              t.id === existing.id ? { ...t, preview: false } : t,
            ),
      });
      return;
    }
    if (preview) {
      const pv = tabs.find((t) => t.preview);
      if (pv) {
        // THE preview tab: one per strip, reused by every single-click.
        set({
          activeId: pv.id,
          tabs: tabs.map((t) => (t.id === pv.id ? { ...t, file } : t)),
        });
        return;
      }
    }
    const tab: ViewerTab = { id: nextId(), file, preview };
    set({ tabs: [...tabs, tab], activeId: tab.id });
  },

  promote: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)),
    })),

  activate: (id) => set({ activeId: id }),

  close: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeId =
        s.activeId === id
          ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null)
          : s.activeId;
      return { tabs, activeId };
    }),

  closeAll: () => set({ tabs: [], activeId: null }),
}));
