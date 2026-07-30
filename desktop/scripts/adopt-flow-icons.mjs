/**
 * Adopt flow's drawing for names where flow draws the same thing under another
 * word. Replaces the charmed art in the live set, in both themes.
 *
 * Only the names approved one by one — the rest of the gap stays as it is. In
 * particular NOT the ones where flow's word is narrower than ours: giving `.h`
 * flow's `c` would make a header indistinguishable from a source file, and that
 * is a loss of information, not a change of style.
 *
 * The light-UI copy is translated with the same palette table the rest of the
 * set went through, so an adopted icon sits beside an existing one without
 * announcing itself.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const FLOW = "D:/alexivanov/Desktop/flow-icons-svgs/dawn";
const ICONS = "D:/Projects/claude-code/desktop/src/renderer/public/icons";

/** dawn → the softer ink the light UI uses. Same table as repaint-icons.mjs. */
const SOFTER = {
  "#f8fafc": "#475569",
  "#334155": "#f8fafc",
  "#cbd5e1": "#94a3b8",
  "#93c5fd": "#3b82f6",
  "#c4b5fd": "#8b5cf6",
  "#fda4af": "#f43f5e",
  "#f9a8d4": "#ec4899",
  "#fde047": "#ca8a04",
  "#86efac": "#16a34a",
  "#fdba74": "#ea580c",
  "#5eead4": "#0d9488",
  "#7dd3fc": "#0284c7",
  "#bef264": "#65a30d",
  "#d2a377": "#b45309",
};
const recolour = (svg) =>
  svg.replace(/#[0-9A-Fa-f]{3,8}/g, (m) => SOFTER[m.toLowerCase()] ?? m);

/** ours ← flow's name for the same drawing. */
const ADOPT = {
  folder_source: "folder_src",
  folder_web: "folder_public",
  folder_component: "folder_components",
  folder_commands: "folder_command",
  folder_fonts: "folder_font",
  folder_function: "folder_functions",
  folder_hooks: "folder_hook",
  folder_image: "folder_images",
  folder_package: "folder_packages",
  folder_script: "folder_scripts",
  folder_styles: "folder_style",
  folder_types: "folder_type",
  folder_util: "folder_utils",
  pcss: "postcss",
};

let done = 0;
const problems = [];

const take = (ours, theirs) => {
  const src = join(FLOW, `${theirs}.svg`);
  if (!existsSync(src)) {
    problems.push(`${ours} ← ${theirs}: flow has no such file`);
    return;
  }
  const dawn = readFileSync(src, "utf-8");
  writeFileSync(join(ICONS, "light", `${ours}.svg`), dawn); // dark UI: as drawn
  writeFileSync(join(ICONS, "base", `${ours}.svg`), recolour(dawn)); // light UI
  done++;
};

for (const [ours, theirs] of Object.entries(ADOPT)) {
  take(ours, theirs);
  // A folder is a pair. Adopting only the closed one would leave the old art
  // showing the moment you expanded it.
  if (ours.startsWith("folder_")) {
    if (existsSync(join(FLOW, `${theirs}_open.svg`))) take(`${ours}_open`, `${theirs}_open`);
    else problems.push(`${ours}_open ← ${theirs}_open: flow has no open twin`);
  }
}

console.log(`adopted ${done} files (${Object.keys(ADOPT).length} names)`);
if (problems.length) {
  console.log(`\nPROBLEMS:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
