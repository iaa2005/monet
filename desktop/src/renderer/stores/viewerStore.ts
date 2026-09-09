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
  /**
   * Where the bytes come from: a chat artifact, a file on disk, or a file
   * STAGED in the composer and not sent anywhere yet.
   *
   * A staged file has no path — it is a browser `File` the user dropped a
   * moment ago, and it lives in chatStore.stagedFiles until it is sent. The
   * two ids below are how the viewer finds it again; they are strings so a
   * doc still serialises, and the File itself is never in this object.
   */
  source?: "artifact" | "file" | "staged";
  /** For `staged`: the composer draft key holding it. */
  stagedKey?: string;
  /** For `staged`: the attachment's id within that draft. */
  stagedId?: string;
}

export interface ViewerDoc {
  /** Doubles as the dock panel id: "viewer", "viewer:2", … */
  id: string;
  file: ViewerFile;
  /** Italic tab; the next preview open replaces this one. */
  preview: boolean;
  /** Edited and not yet written to disk — the tab shows a dot. */
  dirty?: boolean;
}

/**
 * What ui-state stores per session.
 *
 * Narrower than ViewerFile on purpose: a staged file cannot be persisted (the
 * File behind it does not survive a reload), and saying so in the type is
 * what keeps serialize's filter and the stored shape from drifting apart.
 */
export type PersistedViewerFile = Omit<
  ViewerFile,
  "source" | "stagedKey" | "stagedId"
> & { source?: "artifact" | "file" };

export interface ViewerDocSnapshot {
  file: PersistedViewerFile;
  preview: boolean;
}

/** Two entries are "the same file" if they resolve to the same thing. */
function sameFile(a: ViewerFile, b: ViewerFile): boolean {
  // Two staged files can share a name — dropping the same photo twice is a
  // thing people do — so the identity is the staged id, not the name.
  if (a.stagedId || b.stagedId)
    return a.stagedId === b.stagedId && a.stagedKey === b.stagedKey;
  if (a.path && b.path) return a.path === b.path && a.source === b.source;
  return a.name === b.name && a.source === b.source && !a.path === !b.path;
}

let seq = 1;
const nextId = (): string => (seq === 1 ? (seq++, "viewer") : `viewer:${seq++}`);

interface ViewerState {
  docs: ViewerDoc[];
  /** The panel the dock last activated — where "open" lands. */
  activeId: string | null;
  /**
   * Bumped every time somebody ASKS to look at a file, even the one already
   * active.
   *
   * `activeId` alone cannot say that. Clicking a link to a file that is
   * already open sets activeId to the value it already had, so nothing
   * changed, so nothing raised the panel — and if the dock happened to be
   * showing a different tab, the click did nothing at all and the file had
   * to be selected by hand. Two actions for one intention; reported.
   *
   * Deliberately NOT bumped by setActive: clicking inside a card sets it
   * active too, and re-raising a panel that is already in front is what
   * takes the caret out of the editor mid-word.
   */
  raiseSeq: number;
  /**
   * Bumped when the caller wants the card given the whole window.
   *
   * "Look at this" and "work on this beside the chat" are different
   * requests. A staged attachment is the first: it was opened to be read or
   * looked at, and the dock's own Maximize is the app's word for that.
   */
  maximizeSeq: number;
  open: (
    file: ViewerFile,
    opts?: { preview?: boolean; maximize?: boolean },
  ) => void;
  /** A preview panel becomes permanent (its tab was clicked). */
  pin: (id: string) => void;
  /** The editor reports unsaved edits so the tab can say so. */
  setDirty: (id: string, dirty: boolean) => void;
  setActive: (id: string) => void;
  close: (id: string) => void;
  closeAll: () => void;
  serialize: () => ViewerDocSnapshot[];
  restore: (snap: ViewerDocSnapshot[] | undefined) => void;
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  docs: [],
  activeId: null,
  raiseSeq: 0,
  maximizeSeq: 0,

  open: (file, opts) => {
    const preview = opts?.preview !== false;
    const { docs } = get();
    if (opts?.maximize) set({ maximizeSeq: get().maximizeSeq + 1 });

    const existing = docs.find((d) => sameFile(d.file, file));
    if (existing) {
      set({
        activeId: existing.id,
        raiseSeq: get().raiseSeq + 1,
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
          raiseSeq: get().raiseSeq + 1,
          docs: docs.map((d) => (d.id === pv.id ? { ...d, file } : d)),
        });
        return;
      }
    }

    const doc: ViewerDoc = { id: nextId(), file, preview };
    set({ docs: [...docs, doc], activeId: doc.id, raiseSeq: get().raiseSeq + 1 });
  },

  pin: (id) =>
    set((s) => ({
      docs: s.docs.map((d) => (d.id === id ? { ...d, preview: false } : d)),
    })),

  setDirty: (id, dirty) =>
    set((s) => {
      const doc = s.docs.find((d) => d.id === id);
      if (!doc || !!doc.dirty === dirty) return s;
      return {
        // An edited file is never a preview: typing in it is the strongest
        // possible statement that it should stay open.
        docs: s.docs.map((d) =>
          d.id === id ? { ...d, dirty, preview: dirty ? false : d.preview } : d,
        ),
      };
    }),

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

  // A staged file exists only while the composer holds it: it has no path,
  // and the File behind it is gone after a reload. Restoring such a card
  // would reopen a tab that can only say the file is not there.
  serialize: () =>
    get()
      .docs.filter((d) => d.file.source !== "staged")
      .map((d) => ({
        file: d.file as PersistedViewerFile,
        preview: d.preview,
      })),

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
