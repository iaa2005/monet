/**
 * The voice map: a portrait of a voice, computed from the voice itself.
 *
 * Supertone's own cards carry a blocky two-tone artwork per voice, and it is
 * not decoration — their mixer draws `style_ttl` as a heatmap, because that
 * tensor IS the voice. So does this: 256 timbre features, averaged over the
 * 50 style tokens, grouped into a 12×12 grid.
 *
 * Two things were measured before settling on that (ten real style files, all
 * dims [1, 50, 256]):
 *
 *   - A straight [12×12] tile of the 50×256 matrix draws the MODEL's latent
 *     structure, not the voice's: all ten maps came out with the same bright
 *     columns and the same dead row, differing only in details. Useless as an
 *     identity.
 *   - Subtracting the average of the ten presets fixes it. What is left is
 *     what makes THIS voice different, every cell alive, and — because
 *     averaging is linear — a blended voice's map lands between its parents'.
 *     Mix Sarah with James and you can see it.
 *
 * Values are 0…15 with 7.5 as "same as the average voice": the sign is the
 * direction, the distance is the strength. Serialised as 144 hex digits, which
 * is small enough to travel in the TTS status and to sit in the catalogue for
 * voices not downloaded yet.
 */

export const MAP_SIZE = 12;
const CELLS = MAP_SIZE * MAP_SIZE;

/** style_ttl's shape, and therefore this map's input. */
export const STYLE_TOKENS = 50;
export const STYLE_FEATURES = 256;

/**
 * The average of the ten preset voices in the grid above, ×10⁶.
 * Generated from the published style files; the mean is a fact about them,
 * not a tunable.
 */
const BASELINE: number[] = [
  6300, -6461, 9809, 5389, -4161, 2932, -6741, 6790, -5389, -2693, -6174, 665,
  -1383, 3382, -2140, -2468, 3087, 1738, 3647, 11598, -8075, 3662, 2006, 4143,
  -5135, 9580, 8046, -11591, 4914, 9566, -3961, 6380, -517, 5425, 5356, 347,
  -3316, 893, 1542, 4096, 4204, -3287, -3941, -3859, -6924, -3400, 2054, 2139,
  288, -1190, -20543, -3566, 1925, 1868, 2476, -2454, 4392, 133, -6672, 6931,
  3774, 483, 2293, 2483, -2258, 6163, -6144, -4229, -4240, -9073, -3213, 6661,
  -7881, 3229, -6781, 1592, -18159, -2847, 7546, -3093, 3140, -1477, -4133, 1662,
  5400, -17421, -2182, 6986, -735, 1091, 5113, 1959, -7073, -1847, 446, -3777,
  4905, -15663, -4616, 3344, 6179, -4179, -1156, -10692, 2827, 582, 106394, -769,
  -527, -8359, -3239, 7838, -4050, -3983, -5811, 2049, 254, -8537, 1366, 3116,
  1772, -10741, 77029, -5312, 11020, -2687, -323, 1174, 4409, -9002, 15520, 5828,
  -2681, 1974, 6151, 3655, -2109, -1466, -6142, -6957, 3731, -7257, -5195, 7423,
];

/** Where the scale saturates: the 90th percentile of |deviation| across the
 * ten presets, so a typical voice uses most of the range and an outlier
 * clamps instead of flattening everyone else. */
const MAP_SCALE = 0.010907;

const HEX = "0123456789abcdef";

/** Row-major cell index → the feature range it averages. */
function featureRange(i: number): [number, number] {
  const a = Math.floor((i * STYLE_FEATURES) / CELLS);
  const b = Math.max(a + 1, Math.floor(((i + 1) * STYLE_FEATURES) / CELLS));
  return [a, b];
}

/**
 * The map for a style tensor, flattened row-major (50 tokens × 256 features).
 * Returns null rather than a wrong picture if the shape is not what the model
 * uses — the caller falls back to the name-derived art.
 */
export function styleMap(ttl: number[]): string | null {
  if (ttl.length !== STYLE_TOKENS * STYLE_FEATURES) return null;
  const feat = new Array<number>(STYLE_FEATURES).fill(0);
  for (let y = 0; y < STYLE_TOKENS; y++) {
    const row = y * STYLE_FEATURES;
    for (let x = 0; x < STYLE_FEATURES; x++) feat[x] += ttl[row + x];
  }
  for (let x = 0; x < STYLE_FEATURES; x++) feat[x] /= STYLE_TOKENS;

  let out = "";
  for (let i = 0; i < CELLS; i++) {
    const [a, b] = featureRange(i);
    let sum = 0;
    for (let x = a; x < b; x++) sum += feat[x];
    const dev = sum / (b - a) - BASELINE[i] / 1e6;
    const q = Math.round(7.5 + (7.5 * dev) / MAP_SCALE);
    out += HEX[Math.max(0, Math.min(15, q))];
  }
  return out;
}

/** A map back to cells, 0…15. Anything malformed reads as flat. */
export function mapCells(hex: string | undefined | null): number[] {
  if (!hex || hex.length !== CELLS || !/^[0-9a-f]+$/.test(hex))
    return new Array<number>(CELLS).fill(8);
  return [...hex].map((c) => HEX.indexOf(c));
}
