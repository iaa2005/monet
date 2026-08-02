/**
 * What a stored desk is allowed to bring back.
 *
 * A dock layout is written per chat and read months later, possibly by a
 * build whose panels changed. The sanitizer is the only thing between that
 * file and dockview's fromJSON, which throws on the first unknown component
 * and takes the whole desk down with it. The rules held here:
 *
 *  - a panel this build does not know disappears, and the group that held
 *    only it disappears with it;
 *  - floating groups survive, in both serialized forms;
 *  - popout groups do not reopen — they are OS windows, and restoring one
 *    would fling windows open at app start — but their PANELS come back as
 *    floating groups instead of vanishing with the window;
 *  - a desk with nothing left is null, which the wing reads as "closed".
 */

import {
  deskPanelIds,
  sanitizeDockLayout,
} from "../src/renderer/dock/dock-layout";
import {
  DOCK_PANEL_IDS,
  GLOBAL_PANEL_IDS,
  RESTORABLE_PANEL_IDS,
} from "../src/renderer/dock/dock-store";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

const KNOWN = ["main", "files", "artifacts", "changes", "browser", "tasks", "terminal"];

const leaf = (id: string, views: string[], activeView?: string) => ({
  type: "leaf",
  data: { views, activeView: activeView ?? views[0], id },
  size: 200,
});

/** A realistic desk: browser+files stacked, terminal split below, one float. */
const desk = () => ({
  grid: {
    root: {
      type: "branch",
      data: [
        leaf("g1", ["browser", "files"], "browser"),
        leaf("g2", ["terminal"]),
      ],
      size: 400,
    },
    width: 400,
    height: 600,
    orientation: "VERTICAL",
  },
  panels: {
    browser: { id: "browser", contentComponent: "browser", title: "Browser", renderer: "always" },
    files: { id: "files", contentComponent: "files", title: "Files" },
    terminal: { id: "terminal", contentComponent: "terminal", title: "Terminal" },
    tasks: { id: "tasks", contentComponent: "tasks", title: "Tasks" },
    changes: { id: "changes", contentComponent: "changes", title: "Changes" },
  },
  activeGroup: "g1",
  floatingGroups: [
    { data: { views: ["tasks"], activeView: "tasks", id: "gf" }, position: { left: 10, top: 10, width: 300, height: 200 } },
  ],
  popoutGroups: [{ data: { views: ["changes"], id: "gp" }, position: null }],
});

// ── 1. A healthy desk passes through intact ───────────────────────────
{
  const out = sanitizeDockLayout(desk(), KNOWN)!;
  check("a healthy desk survives", out !== null);
  check("all five panels kept", Object.keys(out.panels as object).length === 5);
  const root = (out.grid as { root: { data: unknown[] } }).root;
  check("both grid groups kept", root.data.length === 2, root.data.length);
  const fgs = out.floatingGroups as { data: { views: string[] } }[];
  check(
    "the floating group survives, and the popout's panel joins it as floating",
    Array.isArray(fgs) && fgs.length === 2,
    fgs?.length,
  );
  check(
    "the popout window itself never reopens",
    !("popoutGroups" in out),
  );
  check(
    "its panel is the one that came back",
    fgs?.some((f) => f.data.views.includes("changes")),
    JSON.stringify(fgs?.map((f) => f.data.views)),
  );
  check("activeGroup still valid, kept", out.activeGroup === "g1");

  // A corrupt desk that lists one panel in the grid AND a popout must not
  // resurrect it twice — a duplicated view is exactly what fromJSON throws on.
  const dup = desk();
  (dup.popoutGroups as { data: { views: string[]; id: string } }[]).push({
    data: { views: ["files"], id: "gp2" },
  } as never);
  const dedup = sanitizeDockLayout(dup, KNOWN)!;
  const dupFgs = dedup.floatingGroups as { data: { views: string[] } }[];
  check(
    "a panel already in the grid is not duplicated from a popout",
    dupFgs.every((f) => !f.data.views.includes("files")),
    JSON.stringify(dupFgs.map((f) => f.data.views)),
  );
}

// ── 2. An unknown panel vanishes, and takes its lonely group along ────
{
  const d = desk();
  (d.panels as Record<string, unknown>)["diff"] = { id: "diff", contentComponent: "diff" };
  d.grid.root.data.push(leaf("g3", ["diff"]));
  const out = sanitizeDockLayout(d, KNOWN)!;
  check("the unknown panel is dropped", !("diff" in (out.panels as object)));
  const root = (out.grid as { root: { data: { data: { id: string } }[] } }).root;
  check(
    "and its group with it",
    root.data.length === 2 && !root.data.some((n) => n.data.id === "g3"),
    root.data.length,
  );
}

// ── 3. A mixed group only loses the unknown view ──────────────────────
{
  const d = desk();
  (d.panels as Record<string, unknown>)["diff"] = { id: "diff", contentComponent: "diff" };
  d.grid.root.data[0] = leaf("g1", ["browser", "diff", "files"], "diff");
  const out = sanitizeDockLayout(d, KNOWN)!;
  const g1 = (out.grid as { root: { data: { data: { views: string[]; activeView: string } }[] } })
    .root.data[0]!.data;
  check("known views stay", g1.views.join(",") === "browser,files", g1.views.join(","));
  check(
    "an active view that vanished falls back to the first",
    g1.activeView === "browser",
    g1.activeView,
  );
}

// ── 4. The active group is only named while it exists ─────────────────
{
  const d = desk();
  d.activeGroup = "g9";
  const out = sanitizeDockLayout(d, KNOWN)!;
  check("a dangling activeGroup is dropped", !("activeGroup" in out));
}

// ── 5. Nothing left means null, not an empty desk ─────────────────────
{
  const d = desk();
  d.panels = {
    ghost: { id: "ghost", contentComponent: "ghost", title: "?" },
  } as never;
  check("all-unknown panels → null", sanitizeDockLayout(d, KNOWN) === null);
  check("junk → null", sanitizeDockLayout("nonsense", KNOWN) === null);
  check("null → null", sanitizeDockLayout(null, KNOWN) === null);
  check("empty object → null", sanitizeDockLayout({}, KNOWN) === null);
}

// ── 6. A desk living entirely in floating groups is still a desk ──────
{
  const d = desk();
  d.grid.root = { type: "branch", data: [], size: 400 } as never;
  d.panels = {
    tasks: { id: "tasks", contentComponent: "tasks", title: "Tasks" },
  } as never;
  delete (d as { activeGroup?: string }).activeGroup;
  const out = sanitizeDockLayout(d, KNOWN);
  check("floating-only desk survives", out !== null && Array.isArray(out.floatingGroups));
}

// ── 7. deskPanelIds answers "is anything open" for both desk kinds ────
{
  check(
    "layout desks count their panels",
    deskPanelIds({ kind: "layout", layout: desk() as never }).length === 5,
  );
  check(
    "open desks count their list",
    deskPanelIds({ kind: "open", open: ["browser", "terminal"] }).join(",") ===
      "browser,terminal",
  );
  check("no desk, no panels", deskPanelIds(null).length === 0);
}

// ── 8. A file comes back where it was left ───────────────────────
//
// The viewer used to be excluded from a restored desk: a file was the chat's,
// the layout was the desk's, and a viewer panel restored with nothing behind
// it would be an empty tab to close. Coming back to a chat then meant coming
// back to the right files in the wrong places — a document split beside the
// conversation returned stacked on top of it.
//
// So the cards ARE restored now (the files themselves come back first, from
// the session's viewer state), and a panel that finds no file behind it is
// closed by the sync effect rather than prevented from existing. What this
// section pins down is the layout half: one entry covers every card, because
// the sanitizer filters by component and "viewer:2" renders "viewer".
{
  check(
    "the viewer is a real panel",
    DOCK_PANEL_IDS.includes("viewer"),
    DOCK_PANEL_IDS.join(", "),
  );
  check(
    "and a restorable one",
    RESTORABLE_PANEL_IDS.includes("viewer"),
    RESTORABLE_PANEL_IDS.join(", "),
  );
  check(
    "only the app-level panels are held back",
    RESTORABLE_PANEL_IDS.length === DOCK_PANEL_IDS.length - GLOBAL_PANEL_IDS.length,
    `${RESTORABLE_PANEL_IDS.length} of ${DOCK_PANEL_IDS.length}`,
  );

  // A desk saved with two files open, one of them in its own group: both
  // cards and the group survive the trip.
  const d = desk();
  (d.panels as Record<string, unknown>)["viewer"] = {
    id: "viewer",
    contentComponent: "viewer",
    title: "notes.md",
  };
  (d.panels as Record<string, unknown>)["viewer:2"] = {
    id: "viewer:2",
    contentComponent: "viewer",
    title: "App.tsx",
  };
  d.grid.root.data.push(leaf("gv", ["viewer", "viewer:2"]));
  const out = sanitizeDockLayout(d, RESTORABLE_PANEL_IDS)!;
  check("a saved file card comes back", "viewer" in (out.panels as object));
  check(
    "and so does the second one, id and all",
    "viewer:2" in (out.panels as object),
    Object.keys(out.panels as object).join(", "),
  );
  const root = (out.grid as { root: { data: { data: { id: string; views?: string[] } }[] } }).root;
  const group = root.data.find((n) => n.data.id === "gv");
  check("in the group they were left in", !!group, root.data.map((n) => n.data.id).join(","));
  check(
    "with both cards in it",
    (group?.data.views ?? []).join(",") === "viewer,viewer:2",
    group?.data.views,
  );
  check(
    "and the rest of the desk untouched",
    Object.keys(out.panels as object).length === 7,
    Object.keys(out.panels as object).join(", "),
  );
}

// ── 9. App-level panels are nobody's chat to decide ───────────────────
//
// Routines are the workspace's scheduled jobs. Switching conversations must
// not open or close that panel — so it is excluded from what a saved desk may
// restore, the same exclusion the viewer gets for the opposite reason.
{
  check(
    "routines is an app-level panel",
    GLOBAL_PANEL_IDS.includes("routines"),
    GLOBAL_PANEL_IDS.join(", "),
  );
  check(
    "and therefore not restorable from a chat's desk",
    !RESTORABLE_PANEL_IDS.includes("routines"),
    RESTORABLE_PANEL_IDS.join(", "),
  );

  // A desk saved while it happened to be open must not carry it into another
  // chat: the sanitizer drops it, and the store re-opens it only if it was
  // already open (that half is measured live, in the app).
  const d = desk();
  (d.panels as Record<string, unknown>)["routines"] = {
    id: "routines",
    contentComponent: "routines",
    title: "Routines",
  };
  d.grid.root.data.push(leaf("gr", ["routines"]));
  const out = sanitizeDockLayout(d, RESTORABLE_PANEL_IDS)!;
  check(
    "a saved desk never carries routines into another chat",
    !("routines" in (out.panels as object)),
    Object.keys(out.panels as object).join(", "),
  );
}

console.log(failures ? `\n${failures} FAILED` : "\nALL DOCK-LAYOUT CHECKS PASSED");
process.exit(failures ? 1 : 0);
