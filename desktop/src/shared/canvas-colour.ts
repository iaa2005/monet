/**
 * The colour a window is painted before the renderer paints anything.
 *
 * Electron fills a new window with `backgroundColor` until the first
 * frame arrives. Get it wrong and every window opens with a flash of the
 * wrong colour — which is how three windows kept flashing warm cream long
 * after the canvas had stopped being warm, and the whole app had stopped
 * being orange.
 *
 * These two must equal `--bg-100` in styles/globals.css, light and dark.
 * They are checked against it by scripts/brand-hue-probe.cjs rather than
 * trusted, because a comment asking two files to agree is a comment that
 * eventually stops being true.
 */
export const CANVAS = {
  /** hsl(220 5% 99%) */
  light: "#fcfcfd",
  /** hsl(0 0% 9.4%) */
  dark: "#181818",
} as const;

/**
 * Which one to paint with.
 *
 * The renderer takes its theme from localStorage and falls back to the
 * system preference; main cannot read localStorage before the window
 * exists, so it follows the system. That is right for a first launch and
 * for everyone who never touched the setting, and wrong only for the
 * window of one frame after somebody has overridden it.
 */
export function canvasFor(prefersDark: boolean): string {
  return prefersDark ? CANVAS.dark : CANVAS.light;
}
