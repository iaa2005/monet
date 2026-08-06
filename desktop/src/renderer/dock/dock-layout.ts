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
  | "routines"
  | "browser"
  | "plan"
  | "tasks"
  | "terminal"
  | "vault";

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
  /** Where popout windows should be reopened from. Passed IN rather than
   * read from `location`, so this stays a pure function a probe can drive:
   * the dev renderer's origin carries a port that moves between runs, and a
   * stored URL from the last session would open a dead page. */
  popoutUrl?: string,
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

  // FLOATING GROUPS ARE ABOLISHED. They were a third state between docked
  // and detached: a card floating inside the app frame that could not be
  // dragged out of it. A layout written by an older build may still carry
  // some, and their panels are the user's — so they are not dropped, they
  // are re-docked: their views are lifted out here and appended to the grid
  // after the restore (see dock-store.dockStrays).
  const strays: string[] = [];
  const liftViews = (data: unknown): void => {
    if (!isRecord(data)) return;
    const views = (data as LeafData).views;
    if (Array.isArray(views))
      for (const v of views)
        if (typeof v === "string" && keep.has(v) && !strays.includes(v))
          strays.push(v);
  };
  if (Array.isArray(raw.floatingGroups)) {
    for (const fg of raw.floatingGroups) {
      if (!isRecord(fg)) continue;
      if (isRecord(fg.data)) liftViews(fg.data);
      else if (isRecord(fg.grid) && isRecord(fg.grid.root)) {
        const collect = (n: unknown): void => {
          if (!isRecord(n)) return;
          if (n.type === "leaf") liftViews(n.data);
          else if (n.type === "branch" && Array.isArray(n.data))
            for (const c of n.data) collect(c);
        };
        collect(fg.grid.root);
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

  // POPOUT GROUPS SURVIVE. A window the user pulled out stays a window when
  // they come back to this chat — dockview reopens it from this very block
  // (the app allows window.open for its own popout page). What is rewritten
  // is the URL: a stored one carries the origin of the session that wrote
  // it, and in dev that port moves.
  const popouts: unknown[] = [];
  if (Array.isArray(raw.popoutGroups)) {
    for (const pg of raw.popoutGroups) {
      if (!isRecord(pg)) continue;
      const withUrl = (o: Record<string, unknown>): Record<string, unknown> =>
        popoutUrl ? { ...o, url: popoutUrl } : o;
      if (isRecord(pg.data)) {
        const views = Array.isArray((pg.data as LeafData).views)
          ? ((pg.data as LeafData).views as unknown[]).filter(
              (v) => typeof v === "string" && !placed.has(v as string),
            )
          : [];
        const leaf = walk({ type: "leaf", data: { ...pg.data, views } }, keep);
        if (!leaf) continue;
        for (const v of (leaf as { data: LeafData }).data.views as string[])
          placed.add(v);
        popouts.push(withUrl({ ...pg, data: (leaf as { data: unknown }).data }));
      } else if (isRecord(pg.grid) && isRecord(pg.grid.root)) {
        const sub = walk(pg.grid.root, keep);
        if (!sub) continue;
        collectPlaced(sub);
        popouts.push(withUrl({ ...pg, grid: { ...pg.grid, root: sub } }));
      }
    }
  }

  // Anything lifted out of an old floating group that is not already placed
  // somewhere real: hand it to the caller to dock after the restore.
  const toDock = strays.filter((v) => !placed.has(v));

  // A layout can live entirely in popout windows — a grid with no root is
  // fine then, but one with neither grid nor windows nor strays is nothing.
  if (!root && popouts.length === 0 && toDock.length === 0) return null;

  const groups = new Set<string>();
  leafIds(root, groups);

  const out: Record<string, unknown> = {
    ...raw,
    grid: { ...raw.grid, root: root ?? { type: "branch", data: [] } },
    panels,
  };
  // The in-frame floating state does not exist any more (DockArea passes
  // disableFloatingGroups); their panels ride in `dockAfterRestore`.
  delete out.floatingGroups;
  if (popouts.length > 0) out.popoutGroups = popouts;
  else delete out.popoutGroups;
  if (toDock.length > 0) out.dockAfterRestore = toDock;
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
