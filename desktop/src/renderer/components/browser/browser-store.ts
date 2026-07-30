/**
 * Browser panel state: tabs, which one is showing, how much room it takes.
 *
 * Deliberately NOT in chatStore. A tab outlives the chat it was opened from —
 * you point the panel at your dev server once and keep it there across chats —
 * and chatStore is saved per session.
 */

import { create } from "zustand";
import { normalizeUrl } from "./url-input";

export type BrowserLayout = "panel" | "expanded";

export interface BrowserTab {
  id: string;
  /**
   * Where the page actually is (from did-navigate). Also what a remounting
   * BrowserView loads: close the right panel and reopen it and you land where
   * you were, not back at the URL the tab was opened with.
   */
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}

interface BrowserState {
  tabs: BrowserTab[];
  activeId: string | null;
  layout: BrowserLayout;
  designMode: boolean;
  /** Chromium partition, resolved from main once per workspace. */
  partition: string | null;

  openTab: (url?: string) => string;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
  patchTab: (id: string, patch: Partial<BrowserTab>) => void;
  setLayout: (layout: BrowserLayout) => void;
  toggleLayout: () => void;
  setDesignMode: (on: boolean) => void;
  setPartition: (partition: string) => void;
}

const BLANK = "about:blank";

let seq = 0;
const nextId = (): string => `tab-${Date.now().toString(36)}-${++seq}`;

export const useBrowserStore = create<BrowserState>((set, get) => ({
  tabs: [],
  activeId: null,
  layout: "panel",
  designMode: false,
  partition: null,

  openTab: (url) => {
    const target = url ? (normalizeUrl(url) ?? BLANK) : BLANK;
    const id = nextId();
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          id,
          url: target,
          title: "",
          favicon: null,
          loading: target !== BLANK,
          canGoBack: false,
          canGoForward: false,
          error: null,
        },
      ],
      activeId: id,
    }));
    return id;
  },

  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return {};
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (s.activeId !== id) return { tabs };
      // Focus the neighbour on the right, or the new last tab — never nothing
      // while tabs remain, which would show the empty state over live pages.
      const next = tabs[idx] ?? tabs[idx - 1] ?? null;
      return { tabs, activeId: next?.id ?? null };
    }),

  selectTab: (id) => set({ activeId: id }),

  patchTab: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  setLayout: (layout) => set({ layout }),
  toggleLayout: () =>
    set((s) => ({ layout: s.layout === "panel" ? "expanded" : "panel" })),

  setDesignMode: (on) => set({ designMode: on }),
  setPartition: (partition) => set({ partition }),
}));

/** The showing tab, or null when the panel is empty. */
export function activeTab(): BrowserTab | null {
  const { tabs, activeId } = useBrowserStore.getState();
  return tabs.find((t) => t.id === activeId) ?? null;
}
