/**
 * Experimental icons — the 47 names flow does not have, drawn in flow's manner.
 *
 * Output goes to icons/experimental/, NOT into the live set. Nothing reads it;
 * it is there to be looked at and judged.
 *
 * What flow's style actually is, read off its own files rather than guessed:
 *   • a 16×16 canvas, and shapes rounded hard — radius 3 of 16 on a container
 *   • a container drawn at 40% (documents) or 80% (folder fronts) of its colour
 *   • over every shape, a second copy filled #f8fafc at 10% and drawn as a RING
 *     (outer path + inset path, fill-rule evenodd) — that is the "окантовка"
 *   • the glyph at full colour, with the same 10% ring over it
 *   • open and closed folders are different drawings, not one rotated
 *
 * One thing here is deliberately NOT flow: in flow, the folder front has a bite
 * cut out of it, shaped around that icon's own glyph — five folders checked,
 * five different body paths. That is hand-work per icon, and 670 of them is why
 * their set is the size it is. These use one common body with the glyph inside
 * it instead. It reads as the same family; it is not the same labour.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const FLOW = "D:/alexivanov/Desktop/flow-icons-svgs/dawn";
// Outside public/ on purpose: nothing in the app reads these, and public/ is
// copied wholesale into the build — an experiment should not ship.
const OUT = "D:/Projects/claude-code/desktop/icons-experimental";

/** dawn's palette → the softer ink the light UI uses. Same table the live set
 * was translated with, so an experimental icon sits next to a real one without
 * announcing itself. */
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

/**
 * Names flow already draws, under another word. Copying its file is better than
 * anything drawn here: it IS the style, not an impression of it.
 */
const ALIAS = {
  // plural/singular — flow simply chose the other one
  folder_commands: "folder_command",
  folder_component: "folder_components",
  folder_fonts: "folder_font",
  folder_function: "folder_functions",
  folder_hooks: "folder_hook",
  folder_image: "folder_images",
  folder_package: "folder_packages",
  folder_script: "folder_scripts",
  folder_styles: "folder_style",
  folder_types: "folder_type",
  folder_util: "folder_utils",
  // same concept, flow's word
  folder_source: "folder_src",
  folder_web: "folder_public",
  pcss: "postcss",
  "cpp-header": "cpp",
  "c-header": "c",
  "fortran-fixed": "fortran",
  "luau-config": "luau",
  "luau-def": "luau",
  "astro-config": "astro",
  "lua-config": "lua",
  "go-mod": "go",
  // Note: flow has folder_next, folder_nuxt and folder_drizzle but no FILE
  // icon for any of them, so next/nuxt/vite/drizzle-orm are drawn below.
};

// ── flow's containers, lifted verbatim ────────────────────────────────
/**
 * A typed file is a SQUARE with radius 4 — read off flow's typescript.svg, not
 * guessed. The document-with-a-folded-corner is reserved for `document` itself;
 * building the type icons on it made them read as notes rather than as members
 * of flow's set, which is what "криво" was pointing at.
 */
const SQUARE_BODY =
  "M5 1h6a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4";
const SQUARE_RING =
  "M15 5v6a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4M5 2a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V5a3 3 0 0 0-3-3z";

/**
 * The corner bite. flow cuts one per icon, shaped around that icon's glyph;
 * this is one circle, subtracted with fill-rule evenodd, so every folder gets
 * the same gap and every glyph sits in it. Not their hand-work — but it puts
 * the glyph where flow puts it, which is what makes a folder legible at 16px.
 */
// Big, and pushed at the corner: measured off folder_src, flow's cut takes the
// whole bottom-right — its body ends around x=6.4 at the base and the glyph sits
// almost entirely OUTSIDE the folder, overlapping it. A smaller circle punched a
// hole in the middle of the panel instead, which is what read as wrong.
const BITE = "M11.6 17a5.2 5.2 0 1 1 0-10.4 5.2 5.2 0 0 1 0 10.4z";

const DOC_BODY =
  "M5 1h3.76a3 3 0 0 1 2.12.88l2.24 2.24A3 3 0 0 1 14 6.24V12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3";
const DOC_RING =
  "m10.88 1.88 2.24 2.24A3 3 0 0 1 14 6.24V12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3h3.76a3 3 0 0 1 2.12.88M5 2a2 2 0 0 0-2 2v8c0 1.1.9 2 2 2h6a2 2 0 0 0 2-2V6.24a2 2 0 0 0-.59-1.41l-2.24-2.24A2 2 0 0 0 8.76 2z";

const TAB_CLOSED =
  "M9.5 3H12a3 3 0 0 1 3 3v.76a3 3 0 0 0-.44-.32A3 3 0 0 0 12 5H4a3 3 0 0 0-3 3V4a3 3 0 0 1 3-3h1.5C8 1 8 3 9.5 3";
const TAB_OPEN = "M9.5 3H13a2 2 0 0 1 2 2H1V4a3 3 0 0 1 3-3h1.5C8 1 8 3 9.5 3";

const BODY_CLOSED = "M12 5a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z";
const BODY_CLOSED_RING =
  "M12 5a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3zm0 1H4a2 2 0 0 0-2 2v4c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2z";
// Open: the front panel leans out, so its top edge is wider than its base.
const BODY_OPEN =
  "M14 6a2 2 0 0 1 1.96 2.43l-.98 4.22A3 3 0 0 1 12.06 15H3.94a3 3 0 0 1-2.92-2.35L.04 8.43A2 2 0 0 1 2 6z";
const BODY_OPEN_RING =
  "M14 6a2 2 0 0 1 1.96 2.43l-.98 4.22A3 3 0 0 1 12.06 15H3.94a3 3 0 0 1-2.92-2.35L.04 8.43A2 2 0 0 1 2 6zm0 1H2a1 1 0 0 0-.98 1.21l.98 4.23A2 2 0 0 0 3.94 14h8.12a2 2 0 0 0 1.95-1.56l.97-4.23A1 1 0 0 0 14 7z";

/**
 * The glyphs. Kept to a small vocabulary — circles, rounded bars, chevrons —
 * because flow's own are that simple and because a 16px canvas punishes detail.
 * Each sits inside the container, around (8,10) for folders and (8,9) for files.
 */
const G = {
  // ── files ──
  binary: "M5.5 6.5h1.6c.5 0 .9.4.9.9v1.2c0 .5-.4.9-.9.9H5.5a.9.9 0 0 1-.9-.9V7.4c0-.5.4-.9.9-.9m.35 1v1h.9v-1zM9 6.5h1.5a.9.9 0 0 1 .9.9v1.2c0 .5-.4.9-.9.9H9a.9.9 0 0 1-.9-.9V7.4c0-.5.4-.9.9-.9m.35 1v1h.8v-1zM5 11.4h6a.55.55 0 1 1 0 1.1H5a.55.55 0 1 1 0-1.1",
  key: "M10 5.6a2.6 2.6 0 1 1-1.2 4.9l-.35.35a.8.8 0 0 1-.57.24H7.6v.6a.8.8 0 0 1-.8.8h-.6v.6a.8.8 0 0 1-.8.8H4.3a.8.8 0 0 1-.8-.8v-1a.8.8 0 0 1 .23-.57l3.3-3.3A2.6 2.6 0 0 1 10 5.6m.5 1.6a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5",
  lock: "M8 4.5a2.6 2.6 0 0 1 2.6 2.6v1.1c.5 0 .9.4.9.9v2.8c0 .5-.4.9-.9.9H5.4a.9.9 0 0 1-.9-.9V9.1c0-.5.4-.9.9-.9V7.1A2.6 2.6 0 0 1 8 4.5m0 1.15c-.8 0-1.45.65-1.45 1.45v1.1h2.9V7.1c0-.8-.65-1.45-1.45-1.45",
  todo: "M8 4.4a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2m1.8 2.2a.55.55 0 0 0-.78 0L7.4 8.22l-.62-.62a.55.55 0 0 0-.78.78l1.01 1.01c.22.22.57.22.78 0l2.01-2.01a.55.55 0 0 0 0-.78",
  security:
    "M8 4.3l3.1 1.24v2.6c0 1.9-1.28 3.4-3.1 4.06-1.82-.66-3.1-2.16-3.1-4.06v-2.6zm0 1.24L6.05 6.32v1.82c0 1.28.8 2.3 1.95 2.83 1.15-.53 1.95-1.55 1.95-2.83V6.32z",
  "code-of-conduct":
    "M8 4.4c1.1 0 2 .9 2 2 0 .74-.4 1.38-1 1.73v.62l1.6.8c.5.25.8.76.8 1.31v.54c0 .5-.4.9-.9.9H5.5a.9.9 0 0 1-.9-.9v-.54c0-.55.3-1.06.8-1.31l1.6-.8v-.62a2 2 0 0 1-1-1.73c0-1.1.9-2 2-2",
  assembly:
    "M5.4 6h1.1l1.5 5.4a.55.55 0 0 1-1.06.3l-.3-1.1H5.26l-.3 1.1a.55.55 0 0 1-1.06-.3zm.55 1.9-.4 1.6h.8zM9.2 6.2h1.5c.9 0 1.6.7 1.6 1.6 0 .45-.18.85-.47 1.14.3.3.47.7.47 1.16 0 .9-.7 1.6-1.6 1.6H9.2a.55.55 0 0 1-.55-.55V6.75c0-.3.25-.55.55-.55m.55 1.1v1h.95a.5.5 0 0 0 0-1zm0 2.1v1h.95a.5.5 0 0 0 0-1z",
  hcl: "M5.2 5.9a.55.55 0 0 1 .55.55v1.85h2.1V6.45a.55.55 0 1 1 1.1 0v5.1a.55.55 0 1 1-1.1 0V9.4h-2.1v2.15a.55.55 0 1 1-1.1 0v-5.1c0-.3.25-.55.55-.55m6.3 0a.55.55 0 0 1 .55.55v4.55h.6a.55.55 0 1 1 0 1.1h-1.15a.55.55 0 0 1-.55-.55V6.45c0-.3.25-.55.55-.55",
  just: "M10.6 5.9a.55.55 0 0 1 .55.55v3.7a2.15 2.15 0 0 1-4.3 0 .55.55 0 1 1 1.1 0 1.05 1.05 0 0 0 2.1 0v-3.7c0-.3.25-.55.55-.55M4.9 6.6h1.7a.55.55 0 1 1 0 1.1H4.9a.55.55 0 1 1 0-1.1",
  odin: "M8 4.4a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2m0 1.15a2.45 2.45 0 1 0 0 4.9 2.45 2.45 0 0 0 0-4.9m0 1.1a1.35 1.35 0 1 1 0 2.7 1.35 1.35 0 0 1 0-2.7",
  roblox:
    "M6.35 4.4 11.6 5.8a.55.55 0 0 1 .39.67l-1.4 5.25a.55.55 0 0 1-.67.39L4.67 10.7a.55.55 0 0 1-.39-.67l1.4-5.25a.55.55 0 0 1 .67-.38m.42 2.4-.5 1.85 1.85.5.5-1.85z",
  "roblox-model":
    "M8 4.5l3.2 1.6v3.8L8 11.5 4.8 9.9V6.1zm0 1.24L6.05 6.72 8 7.7l1.95-.98zM5.9 7.65v1.55L7.45 10V8.44zm4.2 0L8.55 8.44V10l1.55-.8z",
  "roblox-config":
    "M8 4.5l3.2 1.6v3.8L8 11.5 4.8 9.9V6.1zm0 2.1a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8",
  "visual-studio":
    "M10.6 4.5l1.3.65a.55.55 0 0 1 .3.49v4.72a.55.55 0 0 1-.3.49l-1.3.65a.55.55 0 0 1-.64-.1L7.2 8.7l-1.5 1.15a.4.4 0 0 1-.5-.02l-.9-.78a.4.4 0 0 1 0-.6l1.3-1.13-1.3-1.13a.4.4 0 0 1 0-.6l.9-.78a.4.4 0 0 1 .5-.02L7.2 5.94l2.76-1.34a.55.55 0 0 1 .64-.1m.5 1.72L8.7 8l2.4 1.78z",
  wally: "M4.6 6a.55.55 0 0 1 .67.4l.73 2.9.73-2.9a.55.55 0 0 1 1.07 0l.73 2.9.73-2.9a.55.55 0 1 1 1.07.27l-1.27 5a.55.55 0 0 1-1.07 0L7.26 8.8l-.73 2.87a.55.55 0 0 1-1.07 0l-1.27-5A.55.55 0 0 1 4.6 6",
  "wally-lock":
    "M4.4 6a.55.55 0 0 1 .67.4l.6 2.4.6-2.4a.55.55 0 0 1 1.07 0l.6 2.4.6-2.4a.55.55 0 1 1 1.07.27l-1.14 4.5a.55.55 0 0 1-1.07 0l-.6-2.37-.6 2.37a.55.55 0 0 1-1.07 0l-1.14-4.5A.55.55 0 0 1 4.4 6m7.6 1.2a1.5 1.5 0 0 1 1.5 1.5v.5c.28 0 .5.22.5.5v1.8c0 .28-.22.5-.5.5h-3a.5.5 0 0 1-.5-.5V9.7c0-.28.22-.5.5-.5v-.5a1.5 1.5 0 0 1 1.5-1.5m0 .9a.6.6 0 0 0-.6.6v.5h1.2v-.5a.6.6 0 0 0-.6-.6",
  lune: "M9.4 4.4a3.6 3.6 0 1 0 2.15 6.5A4.3 4.3 0 0 1 9.4 4.4m-.6 1.3a3.2 3.2 0 0 0 1.15 4.32A2.5 2.5 0 1 1 8.8 5.7",
  // flow draws folder_next / folder_nuxt / folder_drizzle but no file icon for
  // any of them, so the file forms are drawn here.
  next: "M8 4.4a3.6 3.6 0 0 1 2.1 6.53L7.05 6.6v3.6a.55.55 0 1 1-1.1 0V6.05c0-.3.25-.55.55-.55h.5c.18 0 .35.09.45.24l3.05 4.31A3.6 3.6 0 1 1 8 4.4m1.5 1.1a.55.55 0 0 1 .55.55v2.4l-1.1-1.55V6.05c0-.3.25-.55.55-.55",
  nuxt: "M8.47 5.72a.55.55 0 0 1 .95 0l2.9 5a.55.55 0 0 1-.48.83H8.9l-.95-1.65 1-1.72.95 1.65h.94zM5.6 7.3a.55.55 0 0 1 .95 0l2.05 3.55a.55.55 0 0 1-.48.82H4.02a.55.55 0 0 1-.47-.82zm0 1.4L4.97 9.8h1.27z",
  vite: "M11.6 5.3a.55.55 0 0 1 .5.85l-3.6 5.9a.6.6 0 0 1-1.02 0L3.9 6.15a.55.55 0 0 1 .6-.83l1.35.36V6.5c0 .5.4.9.9.9h.2v1.6c0 .55.35 1.05.88 1.24l.3.11-.34-1.4a.55.55 0 0 1 .67-.67l.86.2-.56-1.72a.55.55 0 0 1 .7-.7z",
  "drizzle-orm":
    "M5.4 5.6a.55.55 0 0 1 .48.83l-.9 1.55a.55.55 0 0 1-.96-.55l.9-1.55a.55.55 0 0 1 .48-.28m3 0a.55.55 0 0 1 .48.83l-.9 1.55a.55.55 0 0 1-.96-.55l.9-1.55a.55.55 0 0 1 .48-.28m3 0a.55.55 0 0 1 .48.83l-.9 1.55a.55.55 0 1 1-.96-.55l.9-1.55a.55.55 0 0 1 .48-.28m-6 3.5a.55.55 0 0 1 .48.83l-.9 1.55a.55.55 0 0 1-.96-.55l.9-1.55a.55.55 0 0 1 .48-.28m3 0a.55.55 0 0 1 .48.83l-.9 1.55a.55.55 0 0 1-.96-.55l.9-1.55a.55.55 0 0 1 .48-.28m3 0a.55.55 0 0 1 .48.83l-.9 1.55a.55.55 0 1 1-.96-.55l.9-1.55a.55.55 0 0 1 .48-.28",
  _file: null, // handled below — it is the plain document
  _folder: null,

  // ── folders (glyph sits inside the front panel) ──
  folder_auth:
    "M8 7.2a1.5 1.5 0 0 1 1.5 1.5v.6c.28 0 .5.22.5.5v1.7c0 .28-.22.5-.5.5H6.5a.5.5 0 0 1-.5-.5v-1.7c0-.28.22-.5.5-.5v-.6A1.5 1.5 0 0 1 8 7.2m0 .9a.6.6 0 0 0-.6.6v.6h1.2v-.6a.6.6 0 0 0-.6-.6",
  folder_bin:
    "M6.2 7.6h3.6a.5.5 0 0 1 .5.55l-.3 3.1a.9.9 0 0 1-.9.8H6.9a.9.9 0 0 1-.9-.8l-.3-3.1a.5.5 0 0 1 .5-.55m.4-1.3h2.8a.5.5 0 1 1 0 1H6.6a.5.5 0 1 1 0-1",
  folder_builder:
    "M9.9 6.6a1.9 1.9 0 0 1 .5 1.8l1.5 1.5a.55.55 0 0 1-.78.78l-1.5-1.5a1.9 1.9 0 0 1-2.3-2.5l.95.95a.6.6 0 0 0 .85-.85zM6.5 9.3l1.2 1.2-1.6 1.6a.85.85 0 0 1-1.2-1.2z",
  folder_camera:
    "M7.1 6.9h1.8l.35.7h1.05c.5 0 .9.4.9.9v2.8c0 .5-.4.9-.9.9H5.7a.9.9 0 0 1-.9-.9V8.5c0-.5.4-.9.9-.9h1.05zM8 8.6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3",
  folder_marketing:
    "M10.6 6.5a.55.55 0 0 1 .55.55v4.9a.55.55 0 0 1-.9.42L8.1 10.85H7v1.5a.6.6 0 0 1-1.2 0v-1.5h-.3a1.2 1.2 0 0 1 0-2.4h1.6l2.15-1.82a.55.55 0 0 1 .35-.13",
  folder_roblox:
    "M6.9 6.9 10.4 8a.5.5 0 0 1 .34.62l-.93 3.5a.5.5 0 0 1-.62.34L5.7 11.4a.5.5 0 0 1-.34-.62l.93-3.5a.5.5 0 0 1 .61-.38m.3 1.85-.34 1.3 1.3.34.34-1.3z",
  folder_assets:
    "M8 6.6l2.8 1.4v3.1a.6.6 0 0 1-.33.54l-2.2 1.1a.6.6 0 0 1-.54 0l-2.2-1.1a.6.6 0 0 1-.33-.54V8zm0 1.23L6.4 8.63 8 9.43l1.6-.8zM6.3 9.6v1.4L7.45 11.6V10.2zm3.4 0L8.55 10.2v1.4L9.7 11z",
  folder_module:
    "M6.4 6.9h1.5c.4 0 .7.3.7.7v.8h1.9c.4 0 .7.3.7.7v3.2c0 .4-.3.7-.7.7H5.5a.7.7 0 0 1-.7-.7V7.6c0-.4.3-.7.7-.7zm-.5 1.1v3.9h4.6V9.5H7.5V8z",
  folder_page:
    "M6.6 6.8h2.06c.24 0 .47.1.64.27l1.24 1.24c.17.17.26.4.26.63v3.36c0 .5-.4.9-.9.9H6.6a.9.9 0 0 1-.9-.9V7.7c0-.5.4-.9.9-.9m.2 1.1v4.2h3.4V9.4H8.5a.5.5 0 0 1-.5-.5V7.9z",
  folder_model:
    "M8 6.6l2.9 1.45v3.05L8 12.55 5.1 11.1V8.05zm0 1.24L6.55 8.55 8 9.28l1.45-.73zM6.2 9.35v1.15L7.45 11.1V9.97zm3.6 0L8.55 9.97V11.1L9.8 10.5z",
  folder_service:
    "M6 7.1h4a.7.7 0 0 1 .7.7v1a.7.7 0 0 1-.7.7H6a.7.7 0 0 1-.7-.7v-1c0-.4.3-.7.7-.7m.4 1.05a.45.45 0 1 0 0 .9.45.45 0 0 0 0-.9M6 10.3h4a.7.7 0 0 1 .7.7v1a.7.7 0 0 1-.7.7H6a.7.7 0 0 1-.7-.7v-1c0-.4.3-.7.7-.7m.4 1.05a.45.45 0 1 0 0 .9.45.45 0 0 0 0-.9",
  folder_provider:
    "M8 6.7a.55.55 0 0 1 .55.55v1.2h1.1a.55.55 0 0 1 .55.55v.8a2.2 2.2 0 0 1-1.65 2.13v.82a.55.55 0 1 1-1.1 0v-.82A2.2 2.2 0 0 1 5.8 9.8V9c0-.3.25-.55.55-.55h1.1v-1.2c0-.3.25-.55.55-.55m-1.1 2.85v.25a1.1 1.1 0 0 0 2.2 0v-.25z",
  folder_effects:
    "M8 6.6l.62 1.63L10.25 8.85l-1.63.62L8 11.1l-.62-1.63L5.75 8.85l1.63-.62zm3.1 3.4.35.9.9.35-.9.35-.35.9-.35-.9-.9-.35.9-.35z",
  // Lune is the Luau runtime; the name is French for moon, and flow's own
  // folder_lua sits next to it, so a crescent keeps the two apart at 16px.
  folder_lune:
    "M9.3 7a2.9 2.9 0 1 0 1.85 5.14A3.55 3.55 0 0 1 9.3 7m-.75 1.2a2.65 2.65 0 0 0 1.05 3.55 2.15 2.15 0 1 1-1.05-3.55",
};

// ── composition ───────────────────────────────────────────────────────
const svg = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${inner}</svg>`;

/** A shape, its ring, in one colour. */
const layer = (d, ring, colour, opacity) =>
  `<path fill="${colour}" fill-opacity="${opacity}" fill-rule="evenodd" d="${d}"/>` +
  `<path fill="#f8fafc" fill-opacity="0.1" fill-rule="evenodd" d="${ring}"/>`;

/** The glyph: full colour, same ring treatment, so it belongs to the shape. */
const glyph = (d, colour) =>
  `<path fill="${colour}" fill-rule="evenodd" d="${d}"/>` +
  `<path fill="#f8fafc" fill-opacity="0.1" fill-rule="evenodd" d="${d}"/>`;

const fileIcon = (d, colour) =>
  svg(layer(SQUARE_BODY, SQUARE_RING, colour, ".4") + (d ? glyph(d, colour) : ""));

/** `document` and `_file` keep the folded-corner sheet: they ARE the generic
 * file, and the sheet is what says so. */
const sheetIcon = (d, colour) =>
  svg(layer(DOC_BODY, DOC_RING, colour, ".4") + (d ? glyph(d, colour) : ""));

/**
 * The folder glyph is drawn in flow's inverse ink, not in the folder's own
 * colour. On the front panel — the same hue at 80% — a same-colour glyph is
 * invisible; flow avoids this by hanging the glyph off the corner over the page
 * instead, which needs the per-icon bite these do not have.
 *
 * `#334155` is the right choice rather than white because it is half of flow's
 * own inverse pair: the recolour table swaps it with `#f8fafc`, so the glyph is
 * dark ink on a pale folder in the dark UI and pale ink on a saturated folder in
 * the light one. Contrast in both, from one value.
 */
const FOLDER_INK = "#334155";

const folderIcon = (d, colour, open) => {
  // With a glyph, the front panel loses a corner to it — as flow's do. Without
  // one (_folder), the panel stays whole.
  const body = open ? BODY_OPEN : BODY_CLOSED;
  const ring = open ? BODY_OPEN_RING : BODY_CLOSED_RING;
  return svg(
    layer(open ? TAB_OPEN : TAB_CLOSED, open ? TAB_OPEN : TAB_CLOSED, colour, ".4") +
      layer(d ? body + BITE : body, d ? ring + BITE : ring, colour, ".8") +
      // The glyphs are drawn around (8,10) so the file forms can share them;
      // this lands them in the bite at (11.5,11.5) instead of re-cutting
      // fourteen paths by hand.
      // Glyphs are drawn around (8,10) so the file forms can share them; this
      // lands them in the cut at (11.6,11.8), at flow's size — its own folder
      // glyphs run about 8 units across, not 6.
      (d
        ? `<g transform="translate(0.8 -1.7) scale(1.35)">${glyph(d, colour)}</g>`
        : ""),
  );
};

/** Colour per icon. flow assigns by feel; these follow the same palette and the
 * same instinct — keys and locks amber, security green, brands their own. */
const COLOUR = {
  binary: "#cbd5e1",
  key: "#fde047",
  lock: "#fde047",
  todo: "#86efac",
  security: "#86efac",
  "code-of-conduct": "#7dd3fc",
  assembly: "#fda4af",
  hcl: "#c4b5fd",
  just: "#fdba74",
  odin: "#7dd3fc",
  roblox: "#fda4af",
  "roblox-model": "#fda4af",
  "roblox-config": "#fda4af",
  "visual-studio": "#c4b5fd",
  wally: "#fdba74",
  "wally-lock": "#fdba74",
  lune: "#93c5fd",
  _file: "#cbd5e1",
  folder_auth: "#fde047",
  folder_bin: "#cbd5e1",
  folder_builder: "#fdba74",
  folder_camera: "#c4b5fd",
  folder_marketing: "#f9a8d4",
  folder_roblox: "#fda4af",
  folder_lune: "#c4b5fd",
  folder_assets: "#fdba74",
  folder_module: "#c4b5fd",
  folder_page: "#7dd3fc",
  folder_model: "#5eead4",
  folder_service: "#86efac",
  folder_provider: "#93c5fd",
  folder_effects: "#f9a8d4",
  _folder: "#93c5fd",
  next: "#cbd5e1",
  nuxt: "#86efac",
  vite: "#c4b5fd",
  "drizzle-orm": "#bef264",
};

rmSync(OUT, { recursive: true, force: true });
for (const dir of ["base", "light"]) mkdirSync(join(OUT, dir), { recursive: true });

const write = (name, dawn) => {
  writeFileSync(join(OUT, "light", `${name}.svg`), dawn);
  writeFileSync(join(OUT, "base", `${name}.svg`), recolour(dawn));
};

const flowNames = new Set(
  readdirSync(FLOW)
    .filter((f) => f.endsWith(".svg"))
    .map((f) => f.slice(0, -4)),
);

let copied = 0,
  drawn = 0,
  unresolved = [];

// 1. flow's own art, under our name.
for (const [ours, theirs] of Object.entries(ALIAS)) {
  if (!flowNames.has(theirs)) {
    unresolved.push(`${ours} -> ${theirs} (flow has no such file)`);
    continue;
  }
  const art = readFileSync(join(FLOW, `${theirs}.svg`), "utf-8");
  write(ours, art);
  copied++;
  // A folder alias needs its open twin as well.
  if (ours.startsWith("folder_") && flowNames.has(`${theirs}_open`)) {
    write(`${ours}_open`, readFileSync(join(FLOW, `${theirs}_open.svg`), "utf-8"));
    copied++;
  }
};

// 2. Drawn here.
for (const [name, d] of Object.entries(G)) {
  const colour = COLOUR[name] ?? "#cbd5e1";
  if (name.startsWith("folder_") || name === "_folder") {
    write(name, folderIcon(d, colour, false));
    write(`${name}_open`, folderIcon(d, colour, true));
    drawn += 2;
  } else if (name === "_file") {
    write(name, sheetIcon(d, colour));
    drawn++;
  } else {
    write(name, fileIcon(d, colour));
    drawn++;
  }
}

console.log(`copied from flow : ${copied}`);
console.log(`drawn here       : ${drawn}`);
console.log(`total            : ${readdirSync(join(OUT, "base")).length} per theme`);
if (unresolved.length) console.log(`\nunresolved aliases:\n  ${unresolved.join("\n  ")}`);
