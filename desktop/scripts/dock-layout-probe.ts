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
 *  - popout groups never survive — they are OS windows, and this app's
 *    window-open handler denies those by design;
 *  - a desk with nothing left is null, which the wing reads as "closed".
 */

import {
  deskPanelIds,
  sanitizeDockLayout,
} from "../src/renderer/dock/dock-layout";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

const KNOWN = ["files", "artifacts", "changes", "browser", "tasks", "terminal"];

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
  },
  activeGroup: "g1",
  floatingGroups: [
    { data: { views: ["tasks"], activeView: "tasks", id: "gf" }, position: { left: 10, top: 10, width: 300, height: 200 } },
  ],
  popoutGroups: [{ data: { views: ["files"], id: "gp" } }],
});

// ── 1. A healthy desk passes through intact ───────────────────────────
{
  const out = sanitizeDockLayout(desk(), KNOWN)!;
  check("a healthy desk survives", out !== null);
  check("all four panels kept", Object.keys(out.panels as object).length === 4);
  const root = (out.grid as { root: { data: unknown[] } }).root;
  check("both grid groups kept", root.data.length === 2, root.data.length);
  check("the floating group survives", Array.isArray(out.floatingGroups) && out.floatingGroups.length === 1);
  check("popout groups never do", !("popoutGroups" in out));
  check("activeGroup still valid, kept", out.activeGroup === "g1");
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
    deskPanelIds({ kind: "layout", layout: desk() as never }).length === 4,
  );
  check(
    "open desks count their list",
    deskPanelIds({ kind: "open", open: ["browser", "terminal"] }).join(",") ===
      "browser,terminal",
  );
  check("no desk, no panels", deskPanelIds(null).length === 0);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL DOCK-LAYOUT CHECKS PASSED");
process.exit(failures ? 1 : 0);
