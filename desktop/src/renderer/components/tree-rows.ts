/**
 * The file tree as a flat list of rows.
 *
 * The tree used to be recursive components, each owning its own expanded flag
 * and its own children. That reads well and does not scale: a folder of a
 * thousand files is a thousand components, four thousand DOM nodes and five
 * thousand hooks, all of them mounted whether or not you can see them.
 *
 * Measured first, because the obvious suspect was wrong: a folder of 986 files
 * asks the browser for exactly ONE icon — every row after the first is a cache
 * hit on the same URL — so the images were never the cost. The cost is the rows
 * themselves, and the only way to stop paying it without hiding files behind a
 * "show more" is to keep them all in the list and put only the visible ones in
 * the document.
 *
 * That needs one flat, indexable array, which means expansion and loaded
 * children have to live above the rows rather than inside them. Hence this: a
 * pure function from (children, what is open, what is loaded) to what to draw.
 */

export interface TreeEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  path: string;
}

export interface TreeRow {
  entry: TreeEntry;
  depth: number;
}

/**
 * Depth-first, in display order: a folder, then its contents, then its sibling.
 *
 * A folder that is open but whose children have not arrived contributes only
 * itself — the caller draws the pending state, and an empty folder and a
 * loading one look the same here on purpose, since the difference belongs to
 * the view, not the shape of the list.
 */
export function flattenTree(
  children: TreeEntry[],
  expanded: ReadonlySet<string>,
  childrenOf: ReadonlyMap<string, TreeEntry[]>,
  depth = 0,
  out: TreeRow[] = [],
): TreeRow[] {
  for (const entry of children) {
    out.push({ entry, depth });
    if (entry.isDirectory && expanded.has(entry.path)) {
      const kids = childrenOf.get(entry.path);
      if (kids) flattenTree(kids, expanded, childrenOf, depth + 1, out);
    }
  }
  return out;
}

export interface Window {
  /** First row to render. */
  start: number;
  /** One past the last row to render. */
  end: number;
  /** Pixels of empty space standing in for the rows above `start`. */
  padTop: number;
  /** …and for the rows below `end`. */
  padBottom: number;
}

/**
 * Which slice of the list is worth putting in the document.
 *
 * `overscan` rows either side so a flick of the wheel lands on rows that are
 * already there — without it, fast scrolling shows blank bands while React
 * catches up.
 */
export function visibleWindow(
  total: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 8,
): Window {
  if (total === 0 || rowHeight <= 0)
    return { start: 0, end: 0, padTop: 0, padBottom: 0 };

  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight);
  const start = Math.max(0, first - overscan);
  // +1 so a viewport that shows a partial last row still gets that row.
  const end = Math.min(total, first + visible + overscan + 1);

  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (total - end) * rowHeight),
  };
}
