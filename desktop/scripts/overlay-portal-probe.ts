/**
 * A dialog opened from inside the dock must render into <body>.
 *
 * dockview's sashes are z-index 99 and dock.css traps them in a stacking
 * context of their own, so an app modal covers the dock — as long as the modal
 * is rendered by App. Rendered from INSIDE the dock (the chat column is
 * portalled into the main panel; the file tree IS a panel), a `fixed inset-0
 * z-50` overlay is born in that same trapped context and loses to the library:
 * the resize pill of every seam drew on top of the dialog and went on grabbing
 * the mouse through it. Reported with a screenshot, three circles on it.
 *
 * So this is a rule about a place, and the check is a source scan for it: in
 * every file the dock can host, a viewport-covering overlay must be inside a
 * portal. The set of files is READ FROM DockArea rather than listed here — a
 * panel added tomorrow is covered without anyone remembering this probe.
 *
 * What it does not see: a component two hops down the import graph (a card
 * inside a panel). The rule is the same there; this catches the surfaces.
 *
 *   npx tsx scripts/overlay-portal-probe.ts
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}`);
    if (detail !== undefined) console.log("      ", JSON.stringify(detail));
  }
}

const R = join("src", "renderer");
const DOCK = join(R, "dock", "DockArea.tsx");

/** Every component DockArea mounts as a panel, resolved to a file. */
function dockPanels(): string[] {
  const src = readFileSync(DOCK, "utf-8");
  const out: string[] = [];
  for (const m of src.matchAll(/from "@\/(components\/[^"]+)"/g)) {
    const file = join(R, `${m[1]}.tsx`);
    if (existsSync(file)) out.push(file);
  }
  return out;
}

/** The whole conversation column — App portals it INTO the dock's main panel,
 * so every overlay it renders is born inside the dock. */
function chatFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? chatFiles(join(dir, e.name))
      : e.name.endsWith(".tsx")
        ? [join(dir, e.name)]
        : [],
  );
}

const hosted = [
  ...new Set([...dockPanels(), ...chatFiles(join(R, "components", "chat"))]),
];

check("the dock's own imports resolve to panels", dockPanels().length >= 5, {
  found: dockPanels().length,
});
check("the chat column is in scope", hosted.some((f) => f.includes("ChatView")));

/** An overlay that covers the window: fixed, and above the app's own chrome. */
const OVERLAY = /className=\{?"[^"]*\bfixed\b[^"]*\bz-(?:\[)?(\d+)/g;
const PORTALED = /<Portal[>\s]|createPortal\(/;

const offenders: { file: string; z: number }[] = [];
for (const file of hosted) {
  const src = readFileSync(file, "utf-8");
  const portaled = PORTALED.test(src);
  for (const m of src.matchAll(OVERLAY)) {
    const z = Number(m[1]);
    // Below 40 is a click-catcher under a local dropdown, not a modal layer.
    if (z >= 40 && !portaled)
      offenders.push({ file: file.replace(/\\/g, "/"), z });
  }
}

check(
  `every modal layer in the ${hosted.length} dock-hosted files is portalled`,
  offenders.length === 0,
  offenders,
);

// The specific dialogs from the report, by name — so a rewrite that drops the
// portal fails here even if the class string changes shape.
for (const [label, file] of [
  ["the file tree's dialogs and menu", join(R, "components", "FileTree.tsx")],
  ["the permission dialog", join(R, "components", "chat", "PermissionDialog.tsx")],
  ["the checkpoint picker", join(R, "components", "chat", "CheckpointPicker.tsx")],
] as const) {
  const src = readFileSync(file, "utf-8");
  check(`${label} render through the portal`, /<Portal>/.test(src));
}

// And the portal itself is the one door: <body>, not a div of its own.
const portalSrc = readFileSync(join(R, "components", "ui", "portal.tsx"), "utf-8");
check("the portal targets document.body", /createPortal\([^)]*document\.body/s.test(portalSrc));

console.log(
  failures === 0
    ? "\nA DIALOG BELONGS TO THE WINDOW, NOT TO THE PANEL THAT OPENED IT"
    : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
