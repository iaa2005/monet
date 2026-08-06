/**
 * Which way up is this page?
 *
 * A scan fed through a feeder upside down is not rare, and it fails in a way
 * that looks like the scanner is broken rather than the page: the READING
 * MODEL copes — it transcribes rotated text correctly — while the LAYOUT
 * model does not care about rotation at all, so the blocks come back in
 * bottom-to-top order and the document reads backwards, with the last
 * paragraph first.
 *
 * The test is the detector itself. Run it on the page and on the page turned
 * 180°, and keep whichever produced the more confident set of blocks: a
 * layout model trained on upright documents is measurably less sure about an
 * upside-down one. That costs one extra detection — a third of a second —
 * against a page that would otherwise be read in reverse.
 *
 * 90° rotations are not handled here. They need the page re-rendered at a
 * different aspect ratio rather than a pixel flip, and the failure is
 * obvious enough (a wall of nonsense) that nobody mistakes it for a subtle
 * ordering bug.
 */

import type { LayoutBlock } from "./layout.js";

/**
 * How sure the detector is about a page, as one number.
 *
 * Sum rather than average, deliberately: an upside-down page tends to give
 * both fewer blocks and weaker ones, and the sum catches both. An average
 * would call two confident blocks better than nine good ones.
 */
export function layoutConfidence(blocks: LayoutBlock[]): number {
  return blocks.reduce((n, b) => n + b.score, 0);
}

/** Turn RGB pixels 180°, in place of a re-render. */
export function rotate180(
  rgb: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(rgb.length);
  const pixels = width * height;
  for (let i = 0; i < pixels; i++) {
    const src = i * 3;
    const dst = (pixels - 1 - i) * 3;
    out[dst] = rgb[src];
    out[dst + 1] = rgb[src + 1];
    out[dst + 2] = rgb[src + 2];
  }
  return out;
}

/** Move a box to where it lands when the page is turned 180°. */
export function rotateBox180(
  box: [number, number, number, number],
  width: number,
  height: number,
): [number, number, number, number] {
  return [width - box[2], height - box[3], width - box[0], height - box[1]];
}

/**
 * Is the upside-down reading better, and by enough to believe?
 *
 * The margin matters: a page of pure text scores similarly either way, and
 * flipping one that was already upright would be worse than doing nothing.
 * A fifth more confidence is well outside the noise seen between runs on the
 * same page.
 */
export function prefersRotated(upright: number, rotated: number): boolean {
  return rotated > upright * 1.2;
}
