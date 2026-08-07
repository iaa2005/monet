/**
 * What the sessions list is filtered, sorted and drawn by.
 *
 * Shared because both sides need it: the renderer to render, and main to
 * sanitise what it reads off disk. The validation lives HERE rather than
 * in either one, so "which sort modes exist" has a single answer.
 */

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

const oneOf = <T extends string>(value: unknown, allowed: T[], fallback: T): T =>
  typeof value === "string" && (allowed as string[]).includes(value)
    ? (value as T)
    : fallback;

/**
 * Whatever was on disk, made safe, field by field.
 *
 * Not a blanket cast: a value written by an older build — or edited by
 * hand, which a JSON file invites — should cost that ONE field, not leave
 * the list sorted by a mode that no longer exists.
 */
export function sanitiseFilters(saved: unknown): SessionFilters {
  const raw = (saved ?? {}) as Partial<SessionFilters>;
  return {
    status: oneOf(raw.status, ["active", "archived", "all"], "all"),
    activity: oneOf(raw.activity, ["1d", "3d", "7d", "30d", "all"], "all"),
    group: oneOf(raw.group, ["date", "state", "none"], "none"),
    sort: oneOf(raw.sort, ["recency", "name", "activity"], "recency"),
    sortDir: oneOf(raw.sortDir, ["asc", "desc"], "desc"),
    view: oneOf(raw.view, ["compact", "full"], "full"),
  };
}
