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
 * All four right angles are tried. The detector's input is a SQUARE (the
 * page is squashed to 800×800 before it), so turning it costs a loop over
 * pixels rather than a re-render — and only when an angle wins does the
 * page itself get turned, once, so everything downstream sees an upright
 * document instead of carrying an angle around.
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

/**
 * Turn a SQUARE RGB buffer by a right angle.
 *
 * Square because that is what the detector eats: the page is squashed to
 * 800×800 on its way in, so a sideways page can be tested without
 * re-rendering anything. The aspect distortion is the same in every
 * rotation, which is what makes the confidences comparable.
 */
export function rotateSquare(
  rgb: Uint8Array,
  size: number,
  degrees: 0 | 90 | 180 | 270,
): Uint8Array {
  if (degrees === 0) return rgb;
  if (degrees === 180) return rotate180(rgb, size, size);
  const out = new Uint8Array(rgb.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 90° clockwise sends (x, y) to (size-1-y, x); 270° is its inverse.
      const [nx, ny] =
        degrees === 90 ? [size - 1 - y, x] : [y, size - 1 - x];
      const src = (y * size + x) * 3;
      const dst = (ny * size + nx) * 3;
      out[dst] = rgb[src];
      out[dst + 1] = rgb[src + 1];
      out[dst + 2] = rgb[src + 2];
    }
  }
  return out;
}

export type PageAngle = 0 | 90 | 180 | 270;

/**
 * Pick the angle whose layout the detector believes most.
 *
 * Upright wins ties and near-ties on purpose: most pages ARE upright, and
 * turning one that did not need it is a worse failure than leaving a
 * sideways page alone — the text would still be read, just in a strange
 * order, whereas a wrongly rotated page is unreadable.
 */
export function bestAngle(
  scores: { angle: PageAngle; confidence: number }[],
): PageAngle {
  const upright = scores.find((s) => s.angle === 0)?.confidence ?? 0;
  let best: PageAngle = 0;
  let bestScore = upright;
  for (const s of scores) {
    if (s.angle === 0) continue;
    if (s.confidence > bestScore && prefersRotated(upright, s.confidence)) {
      best = s.angle;
      bestScore = s.confidence;
    }
  }
  return best;
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
