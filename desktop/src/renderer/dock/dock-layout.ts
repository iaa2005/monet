/**
 * The saved desk, held to what this build can actually show.
 *
 * A dock layout is persisted per chat and reloaded months later, possibly by
 * a build with different panels. Feeding dockview a layout that names a
 * component it does not know throws mid-restore and takes the whole desk
 * with it — so every stored layout passes through here first: unknown panels
 * are dropped, groups left empty disappear, and a layout with nothing left
 * becomes null (meaning "the wing was closed").
 *
 * Popout windows are dropped outright: they open real OS windows through
 * window.open, which this app's window-open handler deliberately denies.
 *
 * Dependency-free on purpose — the walk is the contract worth probing.
 */

export type DockPanelId =
  | "main"
  | "viewer"
  | "files"
  | "artifacts"
  | "changes"
  | "browser"
  | "tasks"
  | "terminal";

/** The wing's idea of a desk: a real dockview layout, or just "open these". */
export type DockDesk =
  | { kind: "layout"; layout: Record<string, unknown> }
  | { kind: "open"; open: DockPanelId[] };

interface LeafData {
  views?: unknown;
  activeView?: unknown;
  id?: unknown;
  [k: string]: unknown;
}

interface GridNode {
  type?: unknown;
  data?: unknown;
  [k: string]: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Filter one grid tree; returns the node or null when nothing is left. */
function walk(node: unknown, keep: Set<string>): GridNode | null {
  if (!isRecord(node)) return null;
  if (node.type === "leaf") {
    const data = isRecord(node.data) ? (node.data as LeafData) : {};
    const views = Array.isArray(data.views)
      ? data.views.filter((v): v is string => typeof v === "string" && keep.has(v))
      : [];
    if (views.length === 0) return null;
    const activeView =
      typeof data.activeView === "string" && views.includes(data.activeView)
        ? data.activeView
        : views[0];
    return { ...node, data: { ...data, views, activeView } };
  }
  if (node.type === "branch") {
    const children = Array.isArray(node.data)
      ? node.data.map((c) => walk(c, keep)).filter((c): c is GridNode => c !== null)
      : [];
    if (children.length === 0) return null;
    return { ...node, data: children };
  }
  return null;
}

/** Every group id still present in a tree, for validating activeGroup. */
function leafIds(node: GridNode | null, out: Set<string>): void {
  if (!node) return;
  if (node.type === "leaf") {
    const id = isRecord(node.data) ? (node.data as LeafData).id : undefined;
    if (typeof id === "string") out.add(id);
    return;
  }
  if (node.type === "branch" && Array.isArray(node.data))
    for (const c of node.data) leafIds(c as GridNode, out);
}

/**
 * A stored dockview layout, reduced to the panels this build knows.
 * Null when nothing survives — the caller shows a closed wing.
 */
export function sanitizeDockLayout(
  raw: unknown,
  known: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(raw) || !isRecord(raw.grid) || !isRecord(raw.panels)) return null;

  const knownSet = new Set(known);
  const panels: Record<string, unknown> = {};
  for (const [id, state] of Object.entries(raw.panels)) {
    if (!isRecord(state)) continue;
    const component = state.contentComponent;
    if (typeof component === "string" && knownSet.has(component)) panels[id] = state;
  }
  const keep = new Set(Object.keys(panels));
  if (keep.size === 0) return null;

  const root = walk(raw.grid.root, keep);

  // Floating groups: the legacy single-group form carries the leaf's data
  // directly; the nested form carries a whole grid. Both are filtered with
  // the same walk; a group with nothing left is dropped.
  const floating: unknown[] = [];
  if (Array.isArray(raw.floatingGroups)) {
    for (const fg of raw.floatingGroups) {
      if (!isRecord(fg)) continue;
      if (isRecord(fg.data)) {
        const leaf = walk({ type: "leaf", data: fg.data }, keep);
        if (leaf) floating.push({ ...fg, data: (leaf as { data: unknown }).data });
      } else if (isRecord(fg.grid) && isRecord(fg.grid.root)) {
        const sub = walk(fg.grid.root, keep);
        if (sub) floating.push({ ...fg, grid: { ...fg.grid, root: sub } });
      }
    }
  }

  // Popout groups are real OS windows — restoring one would fling windows
  // open at app start. The PANELS in them are still the user's: they come
  // back as floating groups instead of vanishing with the window. A view
  // already placed in the grid or a floating group is skipped — one panel in
  // two places is exactly the corruption fromJSON throws on.
  const placed = new Set<string>();
  const collectPlaced = (n: GridNode | null): void => {
    if (!n) return;
    if (n.type === "leaf" && isRecord(n.data)) {
      const views = (n.data as LeafData).views;
      if (Array.isArray(views))
        for (const v of views) if (typeof v === "string") placed.add(v);
      return;
    }
    if (n.type === "branch" && Array.isArray(n.data))
      for (const c of n.data) collectPlaced(c as GridNode);
  };
  collectPlaced(root);
  for (const fg of floating) {
    if (isRecord(fg) && isRecord(fg.data)) {
      const views = (fg.data as LeafData).views;
      if (Array.isArray(views))
        for (const v of views) if (typeof v === "string") placed.add(v);
    } else if (isRecord(fg) && isRecord(fg.grid))
      collectPlaced((fg.grid as { root?: GridNode }).root ?? null);
  }
  if (Array.isArray(raw.popoutGroups)) {
    let offset = 0;
    for (const pg of raw.popoutGroups) {
      if (!isRecord(pg)) continue;
      // Single-group form carries the leaf directly; the nested form carries
      // a grid whose leaves we lift out one by one.
      const leaves: Record<string, unknown>[] = [];
      if (isRecord(pg.data)) leaves.push(pg.data);
      else if (isRecord(pg.grid) && isRecord(pg.grid.root)) {
        const collect = (n: unknown): void => {
          if (!isRecord(n)) return;
          if (n.type === "leaf" && isRecord(n.data)) leaves.push(n.data);
          else if (n.type === "branch" && Array.isArray(n.data))
            for (const c of n.data) collect(c);
        };
        collect(pg.grid.root);
      }
      for (const data of leaves) {
        const filtered = {
          ...data,
          views: Array.isArray(data.views)
            ? data.views.filter((v) => typeof v === "string" && !placed.has(v))
            : [],
        };
        const leaf = walk({ type: "leaf", data: filtered }, keep);
        if (!leaf) continue;
        for (const v of (leaf as { data: LeafData }).data.views as string[])
          placed.add(v);
        floating.push({
          data: (leaf as { data: unknown }).data,
          position: {
            left: 48 + offset,
            top: 48 + offset,
            width: 560,
            height: 420,
          },
        });
        offset += 32;
      }
    }
  }

  // A layout can live entirely in floating groups — a grid with no root is
  // fine then, but a layout with neither grid nor floating panels is nothing.
  if (!root && floating.length === 0) return null;

  const groups = new Set<string>();
  leafIds(root, groups);

  const out: Record<string, unknown> = {
    ...raw,
    grid: { ...raw.grid, root: root ?? { type: "branch", data: [] } },
    panels,
  };
  if (floating.length > 0) out.floatingGroups = floating;
  else delete out.floatingGroups;
  // Popouts are OS windows; this app denies window.open by design.
  delete out.popoutGroups;
  if (typeof raw.activeGroup !== "string" || !groups.has(raw.activeGroup))
    delete out.activeGroup;
  return out;
}

/** The panel ids a stored desk would open, for "is anything open" checks. */
export function deskPanelIds(desk: DockDesk | null): string[] {
  if (!desk) return [];
  if (desk.kind === "open") return desk.open;
  const panels = (desk.layout as { panels?: Record<string, unknown> }).panels;
  return panels ? Object.keys(panels) : [];
}
