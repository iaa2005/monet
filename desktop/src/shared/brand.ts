/**
 * Every name that says "this app" lives here, once.
 *
 * The app is Code Monet today. The day that changes — a rebrand, a fork, a
 * white-label build — the rename must be one edit, not an archaeology dig
 * through partition strings, DOM attributes, injected globals and dotfile
 * names. Each constant notes what BREAKS if it changes, because several of
 * these are load-bearing in user data:
 *
 *  - DOT_DIR names folders inside users' repositories.
 *  - BROWSER_PARTITION_PREFIX names Chromium cookie stores on disk — change it
 *    and every saved login is orphaned (the old store stays, unreferenced).
 *  - STORAGE_PREFIX keys localStorage — change it and settings reset.
 *
 * Renaming is one edit here, but for those three it is a MIGRATION, not a
 * find-and-replace. The compile-time constants (attributes, globals) are free
 * to change.
 *
 * Shared, dependency-free: main, preload and renderer all read it.
 */

/** The product, as users see it. Window titles, tray, docs. */
export const APP_NAME = "Code Monet";

/** One short word, lowercase — the seed most other names derive from. */
export const BRAND = "monet";

/**
 * The app's folder inside a user's PROJECT (agent config, servers.json,
 * checkpoints). In repos and possibly committed — renaming strands the old
 * folder in every project that has one.
 */
export const DOT_DIR = `.${BRAND}`;

/** Production data dir variant (packaged builds keep data beside the app). */
export const DOT_DIR_PROD = `.${BRAND}-prod`;

/**
 * Project memory files, best first. Ours wins when both exist; CLAUDE.md is
 * read because it is the ecosystem's format and most repos carry that one —
 * interop, not our own legacy.
 */
export const MEMORY_FILENAMES = ["MONET.md", "CLAUDE.md"] as const;

/** The one we write when we get to choose. Reading still accepts both. */
export const MEMORY_FILE = MEMORY_FILENAMES[0];

/**
 * Upstream's names, kept here so the rename is a single-file job.
 *
 * The vendored command registry is written for that product and says so, and
 * its text reaches the user through the "/" menu and reaches the MODEL through
 * command expansion. Both are rewritten on the way out (see shared/rebrand),
 * and neither the source nor the destination should be a literal buried in
 * whatever file happens to do the rewriting.
 */
export const UPSTREAM_NAME = "Claude Code";
/** Upstream's project-memory file — the one MEMORY_FILE replaces in text. */
export const UPSTREAM_MEMORY_FILE = "CLAUDE.md";
/** Upstream's API product. A real thing with a real name: never rewritten. */
export const UPSTREAM_API_NAME = "Claude API";

/**
 * Chromium partition prefix for the Browser panel (see main/browser/session.ts).
 * Named cookie stores live on disk under this — a rename orphans every login.
 */
export const BROWSER_PARTITION_PREFIX = `${BRAND}-browser`;

/** localStorage key prefix in the renderer (`monet.effort`, …). */
export const STORAGE_PREFIX = `${BRAND}.`;

// ─── Names injected into OTHER PEOPLE'S pages ─────────────────────────────
// Prefixed so a page's own code cannot collide with them by accident.

/** The design-mode overlay's global, on the page's window. */
export const PAGE_GLOBAL = `__${BRAND}Design`;

/** The CDP binding design mode answers on. */
export const PAGE_BINDING = `__${BRAND}BrowserEvent`;

/** Marks the overlay's host element in the page's DOM. */
export const OVERLAY_ATTR = `data-${BRAND}-overlay`;

/** Ref attribute BrowserReadPage stamps on interactive elements. */
export const REF_ATTR = `data-${BRAND}-ref`;

/** Marks a reference chip in the composer's contenteditable. */
export const CHIP_ATTR = `data-${BRAND}-chip`;
