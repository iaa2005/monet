/**
 * Collapse a repository's skills into one group.
 *
 * `microsoft/azure-skills` publishes dozens: azure-compliance, azure-rbac,
 * azure-kusto, entra-app-registration… As flat cards they fill the grid, each
 * repeating the same repository, the same 448k installs and the same star
 * count, and push everyone else's work off the screen.
 *
 * Grouping is also why the per-repo cap can go. That cap existed to stop one
 * publisher owning a page — it did so by HIDING their skills, which is the wrong
 * trade when the user is looking for exactly that repo. One collapsed row costs
 * the space of one card and hides nothing.
 *
 * A group of two is not a group: a header plus two rows takes more space than
 * two cards and reads as ceremony. Hence the threshold.
 */

export interface Groupable {
  uid: string;
  name: string;
  /** `owner/repo` for a registry card; the source id for a repo card. */
  repository?: string;
  source: string;
  installs?: number;
  stars?: number;
  installed: boolean;
}

export interface RepoGroup<T extends Groupable> {
  /** `owner/repo`, and the group's identity in the list. */
  key: string;
  items: T[];
  /** How many of them are already installed — shown on the collapsed header. */
  installedCount: number;
  /** The best figures in the group, for ordering groups against loose cards. */
  installs?: number;
  stars?: number;
}

/** A card that stands on its own, or a group of several from one repository. */
export type Row<T extends Groupable> =
  | { kind: "one"; item: T }
  | { kind: "group"; group: RepoGroup<T> };

/** Below this many from one repository, cards stay loose. */
export const MIN_GROUP = 3;

function best(
  items: Groupable[],
  key: "installs" | "stars",
): number | undefined {
  const vals = items
    .map((i) => i[key])
    .filter((v): v is number => typeof v === "number");
  return vals.length ? Math.max(...vals) : undefined;
}

/**
 * Rows in the order given, with runs from one repository collapsed.
 *
 * Order is preserved rather than re-sorted: the caller has already ordered by
 * installs, stars or name, and a group takes the position of its first member.
 * Re-sorting here would silently override the Sort by picker.
 */
export function groupByRepo<T extends Groupable>(
  list: T[],
  minGroup = MIN_GROUP,
): Row<T>[] {
  const byRepo = new Map<string, T[]>();
  const order: string[] = [];
  for (const item of list) {
    const key = item.repository ?? item.source;
    if (!byRepo.has(key)) {
      byRepo.set(key, []);
      order.push(key);
    }
    byRepo.get(key)!.push(item);
  }

  const rows: Row<T>[] = [];
  for (const key of order) {
    const items = byRepo.get(key)!;
    if (items.length < minGroup) {
      for (const item of items) rows.push({ kind: "one", item });
      continue;
    }
    rows.push({
      kind: "group",
      group: {
        key,
        items,
        installedCount: items.filter((i) => i.installed).length,
        installs: best(items, "installs"),
        stars: best(items, "stars"),
      },
    });
  }
  return rows;
}
