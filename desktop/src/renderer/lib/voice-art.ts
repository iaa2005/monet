/**
 * A picture for every voice.
 *
 * Two sources, in this order:
 *
 *   - THE VOICE ITSELF. `art` is a voice map (shared/voice-map.ts): the style
 *     tensor, as a 12×12 grid of how this voice differs from the average one.
 *     That is what Supertone's own cards show and what their mixer draws as a
 *     heatmap, and it means a blended voice LOOKS like a blend of its parents.
 *   - Failing that, the id. A hash-derived identicon, mirrored down the middle
 *     — symmetry is what makes a random grid read as a face. Only reached when
 *     a style file cannot be read at all.
 *
 * Cells are 0…15 either way, with 8 as "nothing to say": the renderer takes
 * the distance from the middle as strength and the side as colour.
 */

import { MAP_SIZE, mapCells } from "@shared/voice-map";

export const ART_SIZE = MAP_SIZE;

/** FNV-1a — a hash, not a mixer, and enough of one for a grid of art. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small deterministic PRNG, so the art never depends on the
 * engine's Math.random or on the order in which voices are drawn. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fallback grid for an id, row-major, `ART_SIZE * ART_SIZE` cells. */
export function voiceArt(id: string): number[] {
  const rand = prng(hash(id));
  const half = Math.ceil(ART_SIZE / 2);
  const cells = new Array<number>(ART_SIZE * ART_SIZE).fill(8);
  for (let y = 0; y < ART_SIZE; y++) {
    for (let x = 0; x < half; x++) {
      const r = rand();
      // Spread across the range the maps use, so both kinds of art render
      // through the same thresholds.
      const cell = r < 0.3 ? Math.round(r * 10) : r > 0.7 ? Math.round(8 + r * 7) : 8;
      cells[y * ART_SIZE + x] = cell;
      cells[y * ART_SIZE + (ART_SIZE - 1 - x)] = cell;
    }
  }
  return cells;
}

/** The grid to draw for a voice: its own map if it has one, else its id. */
export function voiceCells(v: { id: string; art?: string }): number[] {
  return v.art ? mapCells(v.art) : voiceArt(v.id);
}
