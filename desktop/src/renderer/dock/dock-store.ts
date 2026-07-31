/**
 * The dock's front door.
 *
 * Everything outside the wing talks to the dock through this store, never to
 * dockview directly — because the wing UNMOUNTS when its last panel closes,
 * and half the callers (the agent revealing the browser, a chip opening
 * Changes, a session restore) fire while it is down. An order placed with no
 * api is queued as the pending desk; the DockArea consumes it on mount.
 *
 * `open` mirrors which panels exist so header buttons can light up without
 * touching dockview, and `layoutJson` is the serialized desk the ui-state
 * effect persists per chat.
 */

import { create } from "zustand";
import type { DockviewApi } from "dockview-react";
import {
  sanitizeDockLayout,
  type DockDesk,
  type DockPanelId,
} from "./dock-layout";

export const DOCK_TITLES: Record<DockPanelId, string> = {
  files: "Files",
  artifacts: "Artifacts",
  changes: "Changes",
  browser: "Browser",
  tasks: "Tasks",
  terminal: "Terminal",
};

export const DOCK_PANEL_IDS = Object.keys(DOCK_TITLES) as DockPanelId[];

function addPanel(api: DockviewApi, id: DockPanelId): void {
  api.addPanel({
    id,
    component: id,
    title: DOCK_TITLES[id],
    // The browser keeps compositing while hidden behind another tab — the
    // 'always' renderer hides with visibility, not display:none, which is
    // the same trick the tab strip inside the panel already relies on.
    ...(id === "browser" ? { renderer: "always" as const } : {}),
  });
}

interface DockState {
  api: DockviewApi | null;
  /** Ids of the panels currently open (docked or floating). */
  open: DockPanelId[];
  /** A desk waiting for the wing to mount. */
  pending: DockDesk | null;
  /**
   * Panels asked for WHILE a layout desk is pending — "restore the desk,
   * and also reveal the browser". Applied on top after the restore, so the
   * click does not have to choose between itself and the saved layout.
   */
  pendingExtra: DockPanelId[];
  /** The serialized desk, refreshed on every layout change. */
  layoutJson: Record<string, unknown> | null;

  setApi: (api: DockviewApi | null) => void;
  /** Called by DockArea whenever panels are added/removed or moved. */
  syncFromApi: () => void;
  openPanel: (id: DockPanelId) => void;
  closePanel: (id: DockPanelId) => void;
  togglePanel: (id: DockPanelId) => void;
  /** Replace the whole desk (session switch). Null closes everything. */
  applyDesk: (desk: DockDesk | null) => void;
}

export const useDockStore = create<DockState>((set, get) => ({
  api: null,
  open: [],
  pending: null,
  pendingExtra: [],
  layoutJson: null,

  setApi: (api) => {
    set({ api });
    if (!api) return;
    // The desk this fresh dockview instance should show. Not just `pending`:
    // React StrictMode mounts, unmounts and remounts the DockArea in dev,
    // and the first (throwaway) instance consumes the queue — the second,
    // real one then arrived to nothing, emptied `open`, and the wing
    // unmounted itself. Found live: prod build fine, dev build "ничего не
    // открывается". The last serialized layout (or failing that, the open
    // list) rebuilds the desk on ANY remount, StrictMode's included.
    const { pending, pendingExtra, layoutJson, open } = get();
    const desk: DockDesk | null =
      pending ??
      (layoutJson
        ? { kind: "layout", layout: layoutJson }
        : open.length > 0
          ? { kind: "open", open }
          : null);
    set({ pending: null, pendingExtra: [] });
    if (desk) applyToApi(api, desk);
    for (const id of pendingExtra) if (!api.getPanel(id)) addPanel(api, id);
    get().syncFromApi();
  },

  syncFromApi: () => {
    const api = get().api;
    if (!api) {
      set({ open: [], layoutJson: null });
      return;
    }
    const open = api.panels
      .map((p) => p.id)
      .filter((id): id is DockPanelId => id in DOCK_TITLES);
    let layoutJson: Record<string, unknown> | null = null;
    try {
      layoutJson =
        open.length > 0 ? (api.toJSON() as unknown as Record<string, unknown>) : null;
    } catch {
      /* a mid-mutation read is not worth crashing a save over */
    }
    set({ open, layoutJson });
  },

  openPanel: (id) => {
    const { api, pending, pendingExtra } = get();
    if (!api) {
      // The wing is down. Merge into whatever desk is already queued so
      // "restore the layout, and also reveal the browser" keeps both.
      if (pending?.kind === "layout") {
        if (!pendingExtra.includes(id))
          set({ pendingExtra: [...pendingExtra, id] });
        return;
      }
      const open = pending?.kind === "open" ? pending.open : [];
      if (!open.includes(id)) set({ pending: { kind: "open", open: [...open, id] } });
      return;
    }
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    addPanel(api, id);
    get().syncFromApi();
  },

  closePanel: (id) => {
    const { api, pending, pendingExtra } = get();
    if (!api) {
      // Toggling something back off before the wing has even mounted.
      const extra = pendingExtra.filter((x) => x !== id);
      let desk = pending;
      if (desk?.kind === "open") {
        const open = desk.open.filter((x) => x !== id);
        desk = open.length > 0 ? { kind: "open", open } : null;
      }
      set({ pending: desk, pendingExtra: extra });
      return;
    }
    const panel = api.getPanel(id);
    if (panel) api.removePanel(panel);
    get().syncFromApi();
  },

  togglePanel: (id) => {
    const { api, open, pending, pendingExtra } = get();
    const isOpen = api
      ? !!api.getPanel(id)
      : open.includes(id) ||
        pendingExtra.includes(id) ||
        (pending?.kind === "open" && pending.open.includes(id));
    if (isOpen) get().closePanel(id);
    else get().openPanel(id);
  },

  applyDesk: (desk) => {
    const { api } = get();
    if (!api) {
      set({ pending: desk, pendingExtra: [], open: [], layoutJson: null });
      return;
    }
    applyToApi(api, desk);
    get().syncFromApi();
  },
}));

function applyToApi(api: DockviewApi, desk: DockDesk | null): void {
  if (!desk) {
    api.clear();
    return;
  }
  if (desk.kind === "open") {
    for (const id of desk.open) if (!api.getPanel(id)) addPanel(api, id);
    return;
  }
  const clean = sanitizeDockLayout(desk.layout, DOCK_PANEL_IDS);
  if (!clean) {
    api.clear();
    return;
  }
  try {
    api.fromJSON(clean as never);
    // The renderer is part of the panel's stored state, but a layout written
    // by an older build may predate it — the browser must never come back as
    // a display:none panel.
    api.getPanel("browser")?.api.setRenderer("always");
  } catch {
    // A desk that will not load is a desk the user no longer has.
    api.clear();
  }
}

/** True when the wing should be on screen at all. */
export function dockVisible(s: Pick<DockState, "open" | "pending">): boolean {
  return s.open.length > 0 || s.pending !== null;
}
