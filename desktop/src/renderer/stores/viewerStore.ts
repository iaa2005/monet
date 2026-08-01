/**
 * Open files — one dock panel each.
 *
 * There used to be a tab strip INSIDE the viewer, which put a second row of
 * tabs under the dock's own: the panel said "file.ts +1" and the panel's
 * content said it again. A file is a card now. The dock already knows how to
 * arrange, split, drag and pop out cards, so a file inherits all of it for
 * free, and this store shrank to a list.
 *
 * VS Code's preview idiom survives: a single click opens a PREVIEW file, and
 * the next single click replaces it rather than piling up panels. Clicking
 * the panel's own tab (or double-clicking in the tree) pins it.
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

export interface ViewerDoc {
  /** Doubles as the dock panel id: "viewer", "viewer:2", … */
  id: string;
  file: ViewerFile;
  /** Italic tab; the next preview open replaces this one. */
  preview: boolean;
}

/** What ui-state stores per session. */
export interface ViewerDocSnapshot {
  file: ViewerFile;
  preview: boolean;
}

/** Two entries are "the same file" if they resolve to the same thing. */
function sameFile(a: ViewerFile, b: ViewerFile): boolean {
  if (a.path && b.path) return a.path === b.path && a.source === b.source;
  return a.name === b.name && a.source === b.source && !a.path === !b.path;
}

let seq = 1;
const nextId = (): string => (seq === 1 ? (seq++, "viewer") : `viewer:${seq++}`);

interface ViewerState {
  docs: ViewerDoc[];
  /** The panel the dock last activated — where "open" lands. */
  activeId: string | null;
  open: (file: ViewerFile, opts?: { preview?: boolean }) => void;
  /** A preview panel becomes permanent (its tab was clicked). */
  pin: (id: string) => void;
  setActive: (id: string) => void;
  close: (id: string) => void;
  closeAll: () => void;
  serialize: () => ViewerDocSnapshot[];
  restore: (snap: ViewerDocSnapshot[] | undefined) => void;
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  docs: [],
  activeId: null,

  open: (file, opts) => {
    const preview = opts?.preview !== false;
    const { docs } = get();

    const existing = docs.find((d) => sameFile(d.file, file));
    if (existing) {
      set({
        activeId: existing.id,
        // Re-opening a preview as permanent pins it; never the reverse.
        docs: preview
          ? docs
          : docs.map((d) => (d.id === existing.id ? { ...d, preview: false } : d)),
      });
      return;
    }

    if (preview) {
      const pv = docs.find((d) => d.preview);
      if (pv) {
        // THE preview panel: one per desk, reused by every single click, so
        // walking a tree does not leave a card behind for every file.
        set({
          activeId: pv.id,
          docs: docs.map((d) => (d.id === pv.id ? { ...d, file } : d)),
        });
        return;
      }
    }

    const doc: ViewerDoc = { id: nextId(), file, preview };
    set({ docs: [...docs, doc], activeId: doc.id });
  },

  pin: (id) =>
    set((s) => ({
      docs: s.docs.map((d) => (d.id === id ? { ...d, preview: false } : d)),
    })),

  setActive: (id) => set({ activeId: id }),

  close: (id) =>
    set((s) => {
      const idx = s.docs.findIndex((d) => d.id === id);
      const docs = s.docs.filter((d) => d.id !== id);
      return {
        docs,
        activeId:
          s.activeId === id
            ? (docs[Math.min(idx, docs.length - 1)]?.id ?? null)
            : s.activeId,
      };
    }),

  closeAll: () => set({ docs: [], activeId: null }),

  serialize: () =>
    get().docs.map((d) => ({ file: d.file, preview: d.preview })),

  restore: (snap) => {
    if (!snap?.length) {
      set({ docs: [], activeId: null });
      return;
    }
    seq = 1;
    const docs = snap
      .filter((d) => d?.file && typeof d.file.name === "string")
      .map((d) => ({ id: nextId(), file: d.file, preview: !!d.preview }));
    set({ docs, activeId: docs[0]?.id ?? null });
  },
}));
