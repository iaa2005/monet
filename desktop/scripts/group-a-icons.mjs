/**
 * Group A, per instruction — built for review, NOT installed.
 *
 * Output: icons-review/{base,light}. The live set is untouched until you say so.
 *
 * The badges are flow's own, not redrawn: the gear is lifted from its
 * `vue_config`, the padlock from its `cargo_lock`, the tag from its
 * `typescript_def`. flow already had a convention for "this file configures
 * that language" and for "this file locks it" — using its parts means the
 * result IS the style rather than an impression of it.
 *
 * The cut around each badge is the same trick as the folders: paint the badge
 * into a mask with a thick round stroke and it subtracts its own outline plus
 * the stroke's width. The gap is the stroke-width; nothing is traced by hand.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const FLOW = "D:/alexivanov/Desktop/flow-icons-svgs/dawn";
const OUT = "D:/Projects/claude-code/desktop/icons-review";

/** dawn → the light-UI ink. Same table the live set uses, plus indigo for the
 * header variants, which the set had no need of before. */
const SOFTER = {
  "#f8fafc": "#475569",
  "#334155": "#f8fafc",
  "#cbd5e1": "#94a3b8",
  "#93c5fd": "#3b82f6",
  "#818cf8": "#4f46e5", // indigo-400 → indigo-600, 5.6:1 on the light canvas
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

// ── flow's own corner badges, lifted verbatim ─────────────────────────
const GEAR =
  "m13.21 8.55.11.06q.27.16.57.06l.63-.23a.6.6 0 0 1 .72.25l.68 1.12c.14.24.09.54-.14.72l-.52.41a.6.6 0 0 0-.23.5v.12q0 .31.23.5l.53.41c.22.18.27.48.13.72l-.68 1.12a.6.6 0 0 1-.72.25l-.63-.23a.7.7 0 0 0-.57.06l-.11.06q-.27.15-.34.44l-.11.64a.6.6 0 0 1-.58.47h-1.36a.6.6 0 0 1-.58-.47l-.11-.64a.6.6 0 0 0-.34-.44l-.11-.06a.7.7 0 0 0-.57-.06l-.64.23a.6.6 0 0 1-.71-.25l-.68-1.12a.55.55 0 0 1 .13-.72l.53-.41a.6.6 0 0 0 .23-.5v-.12a.6.6 0 0 0-.23-.5l-.53-.41a.55.55 0 0 1-.13-.72l.68-1.12a.6.6 0 0 1 .72-.25l.63.23q.3.1.57-.06l.11-.06q.27-.15.34-.44l.11-.64c.05-.27.3-.47.58-.47h1.36c.29 0 .53.2.58.47l.11.64q.06.29.34.44M11.5 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3";

const LOCK =
  "M12.5 7A2.5 2.5 0 0 1 15 9.5v.59c.58.2 1 .76 1 1.41v3c0 .83-.67 1.5-1.5 1.5h-4A1.5 1.5 0 0 1 9 14.5v-3c0-.65.42-1.2 1-1.41V9.5A2.5 2.5 0 0 1 12.5 7m0 1c-.83 0-1.5.67-1.5 1.5v.5h3v-.5c0-.83-.67-1.5-1.5-1.5";

/** flow's tag shape (typescript_def's base), brought down to badge size and
 * parked in the same corner as the gear and the lock. */
const TAG =
  "M9.55 9.6 12.5 7.9a1.2 1.2 0 0 1 .91-.12l1.81.49c.32.08.51.41.43.72l-.48 1.81c-.08.3-.27.55-.56.72l-2.95 1.7a.9.9 0 0 1-1.23-.33l-1.2-2.08a.9.9 0 0 1 .32-1.22m3.2-.46a.9.9 0 1 0 .9 1.56.9.9 0 0 0-.9-1.56";

/** The neutral flow uses for these markers. */
const BADGE_INK = "#cbd5e1";
/** Gap between badge and the art it sits on, in user units. */
const GAP = 1.15;

const svgOpen = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16">';

/** Draw `d` the way flow draws a marker: solid, then its 10% edge. */
const marker = (d, ink = BADGE_INK) =>
  `<path fill="${ink}" fill-rule="evenodd" d="${d}"/>` +
  `<path fill="#f8fafc" fill-opacity="0.1" fill-rule="evenodd" d="${d}"/>`;

/**
 * flow's icon for `name`, with `badge` set into it: the art is masked by the
 * badge's own outline plus a gap, then the badge is drawn on top.
 */
function withBadge(name, badge) {
  const src = readFileSync(join(FLOW, `${name}.svg`), "utf-8");
  const inner = src.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  // <defs> must stay outside the masked group — a <use> cannot reach a
  // definition that the mask has clipped away.
  const defs = [...inner.matchAll(/<defs>[\s\S]*?<\/defs>/g)].join("");
  const body = inner.replace(/<defs>[\s\S]*?<\/defs>/g, "");
  return (
    svgOpen +
    defs +
    `<defs><mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">` +
    `<rect width="16" height="16" fill="#fff"/>` +
    `<path d="${badge}" fill="#000" stroke="#000" stroke-width="${GAP}" stroke-linejoin="round" stroke-linecap="round"/>` +
    `</mask></defs>` +
    `<g mask="url(#cut)">${body}</g>` +
    marker(badge) +
    "</svg>"
  );
}

/** flow's icon, unchanged. */
const asIs = (name) => readFileSync(join(FLOW, `${name}.svg`), "utf-8");

// ── the header letter ─────────────────────────────────────────────────
/**
 * A thick, round H in place of flow's C, on flow's own hexagon.
 *
 * Its weight matches the C it replaces — flow draws that letter as a 2-unit
 * stroke with round ends, so the bars are 2 across with a 1-unit radius, and
 * the crossbar's caps land on the bars' centre lines.
 */
const H =
  "M6.3 5.9a1 1 0 0 1 1 1v.6h2.4v-.6a1 1 0 1 1 2 0v4.2a1 1 0 1 1-2 0v-.6H7.3v.6a1 1 0 1 1-2 0V6.9a1 1 0 0 1 1-1";

/** flow's c / cpp, with the letter swapped and the blue pushed towards indigo
 * so a header does not read as the source file next to it.
 *
 * indigo-400 rather than indigo-300: at 40% on a dark panel the 300 lost its
 * hue and read grey beside flow's blue, which is the opposite of "bluer". */
function headerIcon(from) {
  const src = readFileSync(join(FLOW, `${from}.svg`), "utf-8");
  const C =
    "M11.33 5.78A1 1 0 0 1 9.67 6.9a2 2 0 1 0 0 2.21 1 1 0 0 1 1.67 1.1 4 4 0 1 1 0-4.42";
  if (!src.includes(C)) throw new Error(`${from}: flow's C path is not where it was`);
  return src.replaceAll(C, H).replaceAll("#93c5fd", "#818cf8");
}

// ── go.mod / go.sum ───────────────────────────────────────────────────
/** A module, as a puzzle piece — socket on top, knob on the right. */
const PUZZLE =
  "M5.6 4.4h1.55a.55.55 0 0 1 .5.78.9.9 0 1 0 1.65 0 .55.55 0 0 1 .5-.78h1.6c.6 0 1.1.5 1.1 1.1v1.55a.55.55 0 0 1-.78.5.9.9 0 1 0 0 1.65.55.55 0 0 1 .78.5v1.7c0 .6-.5 1.1-1.1 1.1H5.6a1.1 1.1 0 0 1-1.1-1.1V5.5c0-.6.5-1.1 1.1-1.1";

const SQUARE_BODY = "M5 1h6a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4";
const SQUARE_RING =
  "M15 5v6a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4M5 2a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V5a3 3 0 0 0-3-3z";

const GO_BLUE = "#7dd3fc";

function goMod() {
  return (
    svgOpen +
    `<path fill="${GO_BLUE}" fill-opacity=".4" fill-rule="evenodd" d="${SQUARE_BODY}"/>` +
    `<path fill="#f8fafc" fill-opacity="0.1" d="${SQUARE_RING}"/>` +
    marker(PUZZLE, GO_BLUE) +
    "</svg>"
  );
}

/** The same module, locked — flow's own padlock, set in the same way. */
function goSum() {
  return (
    svgOpen +
    `<defs><mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">` +
    `<rect width="16" height="16" fill="#fff"/>` +
    `<path d="${LOCK}" fill="#000" stroke="#000" stroke-width="${GAP}" stroke-linejoin="round" stroke-linecap="round"/>` +
    `</mask></defs>` +
    `<g mask="url(#cut)">` +
    `<path fill="${GO_BLUE}" fill-opacity=".4" fill-rule="evenodd" d="${SQUARE_BODY}"/>` +
    `<path fill="#f8fafc" fill-opacity="0.1" d="${SQUARE_RING}"/>` +
    marker(PUZZLE, GO_BLUE) +
    `</g>` +
    marker(LOCK) +
    "</svg>"
  );
}

// ── build ─────────────────────────────────────────────────────────────
const PLAN = {
  "astro-config": () => withBadge("astro", GEAR),
  "c-header": () => headerIcon("c"),
  "cpp-header": () => headerIcon("cpp"),
  "fortran-fixed": () => asIs("fortran"),
  "go-mod": goMod,
  "go-sum": goSum,
  "lua-config": () => withBadge("lua", GEAR),
  "luau-config": () => withBadge("luau", GEAR),
  "luau-def": () => withBadge("luau", TAG),
};

rmSync(OUT, { recursive: true, force: true });
for (const d of ["base", "light"]) mkdirSync(join(OUT, d), { recursive: true });

for (const [name, make] of Object.entries(PLAN)) {
  const dawn = make();
  writeFileSync(join(OUT, "light", `${name}.svg`), dawn);
  writeFileSync(join(OUT, "base", `${name}.svg`), recolour(dawn));
}

const missing = ["astro", "c", "cpp", "fortran", "lua", "luau"].filter(
  (n) => !existsSync(join(FLOW, `${n}.svg`)),
);
console.log(`built ${Object.keys(PLAN).length} icons into icons-review/`);
if (missing.length) console.log(`MISSING flow sources: ${missing.join(", ")}`);
