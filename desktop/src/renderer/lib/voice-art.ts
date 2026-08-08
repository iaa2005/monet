/**
 * A picture for every voice, computed rather than shipped.
 *
 * Supertone's own voice cards carry a blocky generated artwork each, and a
 * list of ten names reads much faster with one. Ten images would be ten files
 * to bundle and nothing at all for a voice the user imports tomorrow — so the
 * art is a pure function of the id: same voice, same picture, forever, and an
 * imported voice gets its own the moment it exists.
 *
 * Mirrored down the middle, like an identicon: symmetry is what makes a random
 * grid read as a FACE rather than as noise.
 */

/** Cell tones: 0 nothing, 1 solid, 2 accent (the brand colour). */
export type VoiceCell = 0 | 1 | 2;

export const ART_SIZE = 8;

/** FNV-1a — a hash, not a mixer, and enough of one for eight bytes of art. */
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

/**
 * The grid for one voice id, row-major, `ART_SIZE * ART_SIZE` cells.
 *
 * Only the left half is drawn and then mirrored; the middle column of an even
 * grid is just the two halves meeting, which is why the pattern always has a
 * spine.
 */
export function voiceArt(id: string): VoiceCell[] {
  const rand = prng(hash(id));
  const half = Math.ceil(ART_SIZE / 2);
  const cells: VoiceCell[] = new Array(ART_SIZE * ART_SIZE).fill(0);
  for (let y = 0; y < ART_SIZE; y++) {
    for (let x = 0; x < half; x++) {
      const r = rand();
      // ~55% ink, a third of it accented: dense enough to be a shape, sparse
      // enough to still look like one at 40 pixels.
      const cell: VoiceCell = r > 0.45 ? (r > 0.85 ? 2 : 1) : 0;
      cells[y * ART_SIZE + x] = cell;
      cells[y * ART_SIZE + (ART_SIZE - 1 - x)] = cell;
    }
  }
  return cells;
}
