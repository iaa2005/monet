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
import type { AddPanelPositionOptions, DockviewApi } from "dockview-react";
import {
  sanitizeDockLayout,
  type DockDesk,
  type DockPanelId,
} from "./dock-layout";

export const DOCK_TITLES: Record<DockPanelId, string> = {
  main: "Chat",
  viewer: "Viewer",
  files: "Files",
  artifacts: "Artifacts",
  changes: "Changes",
  routines: "Routines",
  browser: "Browser",
  plan: "Plan",
  tasks: "Tasks",
  terminal: "Terminal",
};

export const DOCK_PANEL_IDS = Object.keys(DOCK_TITLES) as DockPanelId[];

/**
 * Panels that belong to the APP, not to a chat.
 *
 * Routines are the workspace's scheduled jobs — nothing about them is per
 * conversation, so switching chats must not open or close the panel. Open
 * stays open, closed stays closed: a desk restore neither brings it back nor
 * takes it away.
 */
export const GLOBAL_PANEL_IDS: DockPanelId[] = ["routines"];

/**
 * Panels a SAVED desk may bring back.
 *
 * The viewer is excluded: it is a window onto one file, opened by clicking
 * that file, and a viewer restored with nothing in it is an empty panel the
 * user has to close. Which file was open belongs to the conversation, not to
 * the furniture. Global panels are excluded for the opposite reason — they
 * are not the chat's to decide.
 */
export const RESTORABLE_PANEL_IDS = DOCK_PANEL_IDS.filter(
  (id) => id !== "viewer" && !GLOBAL_PANEL_IDS.includes(id),
);

/**
 * Extra viewer panes: "viewer:2", "viewer:3" — dynamic panel ids sharing the
 * viewer component. They come back from the session's viewerPanes ui-state,
 * not from the dock layout, so the sanitizer's ignorance of them is fine.
 */
export function openViewerPane(id: string): void {
  const st = useDockStore.getState();
  const api = st.api;
  if (!api) {
    // No wing yet: base "viewer" rides the pending desk; extras are recreated
    // by the viewer-sync effect once the wing is up.
    if (id === "viewer") st.openPanel("viewer");
    return;
  }
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id,
    component: "viewer",
    title: "Viewer",
    ...positionBesideMain(api, "viewer"),
  });
  st.syncFromApi();
}

export function closeViewerPane(id: string): void {
  const api = useDockStore.getState().api;
  const panel = api?.getPanel(id);
  if (panel) api?.removePanel(panel);
}

function addPanel(api: DockviewApi, id: DockPanelId): void {
  api.addPanel({
    id,
    component: id,
    title: DOCK_TITLES[id],
    // The browser keeps compositing while hidden behind another tab — the
    // 'always' renderer hides with visibility, not display:none, which is
    // the same trick the tab strip inside the panel already relies on.
    ...(id === "browser" ? { renderer: "always" as const } : {}),
    // Everything else opens BESIDE the chat, not on top of it: a panel that
    // arrives as a tab in the chat's group hides the conversation.
    ...(id !== "main" ? positionBesideMain(api, id) : {}),
  });
}

/**
 * Where a non-main panel lands.
 *
 * The viewer always takes its own group immediately right of the chat: you
 * clicked a file to READ it beside the conversation, and joining whatever
 * group happens to exist would bury it as a tab behind the browser. Every
 * other panel joins the first group that isn't the chat's, so opening three
 * of them does not slice the window into three.
 */
function positionBesideMain(
  api: DockviewApi,
  id: DockPanelId,
): { position?: AddPanelPositionOptions } {
  const main = api.getPanel("main");
  if (!main) return {};
  if (id === "viewer")
    return { position: { referencePanel: "main", direction: "right" } };
  const other = api.groups.find((g) => g !== main.group);
  if (other) return { position: { referenceGroup: other.id, direction: "within" } };
  return { position: { referencePanel: "main", direction: "right" } };
}

/**
 * The chat panel must exist and cannot be absent: the dock IS the app's
 * content area now, and the conversation is its anchor. When other groups
 * already exist (a desk saved before the chat became a panel), it takes the
 * LEFT edge — never a tab inside somebody else's group.
 */
function ensureMain(api: DockviewApi): void {
  if (api.getPanel("main")) return;
  const first = api.groups[0];
  api.addPanel({
    id: "main",
    component: "main",
    title: DOCK_TITLES.main,
    ...(first
      ? { position: { referenceGroup: first.id, direction: "left" } }
      : {}),
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
  /**
   * Where App renders the chat. The `main` dock panel is just a host div;
   * the actual conversation column PORTALS into it from App, so its state
   * (streams, drafts, viewers) never remounts when the dock rearranges.
   */
  mainHost: HTMLElement | null;
  setMainHost: (el: HTMLElement | null) => void;

  setApi: (api: DockviewApi | null) => void;
  /** Called by DockArea whenever panels are added/removed or moved. */
  syncFromApi: () => void;
  openPanel: (id: DockPanelId) => void;
  closePanel: (id: DockPanelId) => void;
  togglePanel: (id: DockPanelId) => void;
  /** Rename a tab — the viewer wears the name of the file it holds. */
  setPanelTitle: (id: DockPanelId, title: string) => void;
  /** Replace the whole desk (session switch). Null closes everything. */
  applyDesk: (desk: DockDesk | null) => void;
}

export const useDockStore = create<DockState>((set, get) => ({
  api: null,
  open: [],
  pending: null,
  pendingExtra: [],
  layoutJson: null,
  mainHost: null,
  setMainHost: (el) => set({ mainHost: el }),

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
    // Mid-mutation events: clear() and fromJSON() fire remove/add events for
    // every panel they touch, and this listener runs INSIDE that cascade.
    // Re-adding the chat panel while dockview is half-way through clearing
    // itself corrupted the desk — which read as "new session has no chat".
    if (applying) return;
    const api = get().api;
    if (!api) {
      set({ open: [], layoutJson: null });
      return;
    }
    // Self-heal: the chat panel has no close button, but a closeAll or a bug
    // could still take it — the conversation must not be closable.
    ensureMain(api);
    const open = api.panels
      .map((p) => p.id)
      .filter((id): id is DockPanelId => id in DOCK_TITLES);
    let layoutJson: Record<string, unknown> | null = null;
    try {
      layoutJson = api.toJSON() as unknown as Record<string, unknown>;
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
    if (id === "main") return; // the conversation is not a closable panel
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

  setPanelTitle: (id, title) => {
    const panel = get().api?.getPanel(id);
    if (panel && title && panel.title !== title) panel.api.setTitle(title);
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

/** True while a whole-desk mutation runs — the event listeners must not
 * react to the storm of add/remove events it fires. */
let applying = false;

/**
 * Is a whole-desk mutation in flight?
 *
 * For listeners that treat a panel's removal as a USER action: clear() and
 * fromJSON() remove every panel on their way through, and reading those as
 * "the user closed the viewer" would wipe the open file on every restore.
 */
export function isApplyingDesk(): boolean {
  return applying;
}

function applyToApi(api: DockviewApi, desk: DockDesk | null): void {
  applying = true;
  // What the app-level panels were doing before this desk arrived — restored
  // afterwards, because a chat switch has no opinion about them.
  const globalsOpen = GLOBAL_PANEL_IDS.filter((id) => !!api.getPanel(id));
  try {
    if (!desk) {
      api.clear();
      ensureMain(api);
      return;
    }
    if (desk.kind === "open") {
      ensureMain(api);
      for (const id of desk.open)
        if (id !== "main" && !api.getPanel(id)) addPanel(api, id);
      return;
    }
    const clean = sanitizeDockLayout(desk.layout, RESTORABLE_PANEL_IDS);
    if (!clean) {
      api.clear();
      ensureMain(api);
      return;
    }
    try {
      api.fromJSON(clean as never);
      // The renderer is part of the panel's stored state, but a layout
      // written by an older build may predate it — the browser must never
      // come back as a display:none panel.
      api.getPanel("browser")?.api.setRenderer("always");
    } catch {
      // A desk that will not load is a desk the user no longer has.
      try {
        api.clear();
      } catch {
        /* even the clear can throw mid-corruption; main is re-added below */
      }
    }
    // A desk saved before the chat became a panel restores without it.
    ensureMain(api);
  } finally {
    // Put the app-level panels back exactly as they were.
    for (const id of globalsOpen) if (!api.getPanel(id)) addPanel(api, id);
    applying = false;
  }
}

/**
 * Test seam: lets a debugging session (or a probe) drive the desk exactly
 * the way App does.
 *
 * Two hosts qualify — the dev server, and a harness that loads the BUILT
 * renderer with NO preload bridge (scripts/dock-click-probe.cjs). The real
 * app never matches: contextBridge has published electronAPI long before
 * this module evaluates. A page that can run this line could reach these
 * stores through React anyway; the condition is about keeping the global
 * out of the shipped app, not about secrecy.
 */
// `typeof window` first: node probes import this module for its constants,
// and both halves of the condition below reach for browser globals.
if (
  typeof window !== "undefined" &&
  (import.meta.env.DEV || !(window as { electronAPI?: unknown }).electronAPI)
)
  (window as unknown as { __monetDock?: unknown }).__monetDock = useDockStore;
