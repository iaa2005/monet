/**
 * What the sessions list is filtered and sorted by — and where it is kept.
 *
 * It used to be a plain `useState` in App, which meant every restart put
 * the list back to "all, ungrouped, by recency". Nobody sets a filter
 * meaning to set it once.
 *
 * localStorage, like the theme and the effort setting: this is a renderer
 * preference, it is tiny, and reading it has to happen before first paint
 * or the list flickers through the default on every launch.
 */

import { STORAGE_PREFIX } from "@shared/brand";

export interface SessionFilters {
  status: string;
  activity: string;
  group: string;
  sort: string;
  sortDir: "asc" | "desc";
  /**
   * How much of each row to draw.
   *
   * "full" keeps the second line — message count and how long ago the
   * chat was used. "compact" drops it, which is the difference between
   * eleven sessions on screen and twenty.
   */
  view: "compact" | "full";
}

export const DEFAULT_FILTERS: SessionFilters = {
  status: "all",
  activity: "all",
  group: "none",
  sort: "recency",
  sortDir: "desc",
  view: "full",
};

const KEY = `${STORAGE_PREFIX}session-filters`;

const ONE_OF = <T extends string>(value: unknown, allowed: T[], fallback: T): T =>
  typeof value === "string" && (allowed as string[]).includes(value)
    ? (value as T)
    : fallback;

/**
 * Read them back, keeping the default for anything unrecognised.
 *
 * Field by field rather than a blanket cast: a stored value from an older
 * build — or a hand-edited one — should cost that one field, not leave
 * the list sorted by a mode that no longer exists.
 */
export function loadFilters(): SessionFilters {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_FILTERS };
    const saved = JSON.parse(raw) as Partial<SessionFilters>;
    return {
      status: ONE_OF(saved.status, ["active", "archived", "all"], "all"),
      activity: ONE_OF(saved.activity, ["1d", "3d", "7d", "30d", "all"], "all"),
      group: ONE_OF(saved.group, ["date", "state", "none"], "none"),
      sort: ONE_OF(saved.sort, ["recency", "name", "activity"], "recency"),
      sortDir: ONE_OF(saved.sortDir, ["asc", "desc"], "desc"),
      view: ONE_OF(saved.view, ["compact", "full"], "full"),
    };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

export function saveFilters(filters: SessionFilters): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(filters));
  } catch {
    // A full or blocked storage is not worth breaking the list over.
  }
}
