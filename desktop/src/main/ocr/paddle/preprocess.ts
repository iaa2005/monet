/**
 * PaddleOCR-VL's image preprocessing, ported from the Python the model ships.
 *
 * This model is not supported by @huggingface/transformers — the library
 * knows its decoder (`ernie4_5`) but not the multimodal wrapper, and the
 * processor that goes with it is a Python file. So the parts the library
 * would normally do are written out here, and this is the first of them.
 *
 * It is a NaViT/Qwen2-VL-style tower: the picture is NOT squashed to a fixed
 * square. It keeps its aspect, is trimmed to a whole number of 14-pixel
 * patches, and becomes a SEQUENCE of patches whose length depends on how big
 * the picture is. That is what makes it good on documents — a wide table is
 * not squeezed into the same grid as a stamp — and it is also why the token
 * count, and therefore the time, varies per page.
 *
 * Ported rather than invented: the SHAPE constants come from
 * `image_processing_paddleocr_vl.py` (patch 14, merge 2, 1/255 rescale,
 * the 510-patch side limit) and the rest from the `preprocessor_config.json`
 * that ships with the weights — see Preprocessing below for why that
 * distinction cost a model its reputation. Getting any of them wrong does
 * not throw; it produces confident nonsense, the same way the wrong weight
 * format did.
 */

/** Side of one patch, in pixels. */
export const PATCH_SIZE = 14;

/** Patches are merged 2×2 before reaching the decoder. */
export const MERGE_SIZE = 2;

/** Hard cap per side, from the Python: 510 patches is 7140 pixels. */
const MAX_PATCHES_PER_SIDE = 510;

/**
 * The numbers the model is actually configured with.
 *
 * All four of these live in `preprocessor_config.json` and all four were
 * once copied out of the Python class's DEFAULTS instead — which is how a
 * port goes wrong without failing. The class defaults to OpenAI CLIP
 * normalisation; the config that ships with the weights overrides it with
 * SigLIP's 0.5/0.5, so every pixel this file produced was shifted and
 * scaled wrong. It defaults `min_pixels` to 130 blocks; the config says
 * 144, so a cropped line of text was read at 1120 pixels wide where the
 * model expects 1204 — one patch column in eight, missing.
 *
 * Nothing threw. The model read Russian as fluent nonsense, and the
 * conclusion drawn was that the model was weak at Russian.
 */
export interface Preprocessing {
  minPixels: number;
  maxPixels: number;
  mean: [number, number, number];
  std: [number, number, number];
}

/** What 1.6 publishes, for a build that ships no config of its own. */
export const DEFAULT_PREPROCESSING: Preprocessing = {
  minPixels: 28 * 28 * 144,
  maxPixels: 28 * 28 * 1280,
  mean: [0.5, 0.5, 0.5],
  std: [0.5, 0.5, 0.5],
};

function triple(
  value: unknown,
  fallback: [number, number, number],
): [number, number, number] {
  if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number"))
    return value as [number, number, number];
  return fallback;
}

/** Read them from the installed model, keeping the defaults for anything
 * a build leaves out. */
export function readPreprocessing(raw: Record<string, unknown>): Preprocessing {
  return {
    minPixels:
      typeof raw["min_pixels"] === "number"
        ? raw["min_pixels"]
        : DEFAULT_PREPROCESSING.minPixels,
    maxPixels:
      typeof raw["max_pixels"] === "number"
        ? raw["max_pixels"]
        : DEFAULT_PREPROCESSING.maxPixels,
    mean: triple(raw["image_mean"], DEFAULT_PREPROCESSING.mean),
    std: triple(raw["image_std"], DEFAULT_PREPROCESSING.std),
  };
}

/** The block every side is rounded to: one merge unit of patches. */
const FACTOR = PATCH_SIZE * MERGE_SIZE;

export interface PatchedImage {
  /** Flattened patches: [numPatches, 3 * PATCH_SIZE * PATCH_SIZE]. */
  pixelValues: Float32Array;
  /** Patch grid as the model counts it: [t, h, w]. */
  gridTHW: [number, number, number];
  numPatches: number;
  /** Tokens the decoder will see for this image (patches after 2×2 merge). */
  numImageTokens: number;
  /** What the image was actually resized to. */
  width: number;
  height: number;
}

/**
 * The size this picture is read at — `smart_resize`, ported.
 *
 * The rule that matters, and the one it took four wrong versions to find:
 * a picture SMALLER than `minPixels` is scaled UP. A cropped line of text
 * is only 33 pixels tall, which is two patches, and at that size the model
 * reads letters by their silhouette — "большом" comes back as "обльшом",
 * "доплыком", "добављом", a different wrong word per attempt. Enlarged to
 * the floor of ~102k pixels it simply reads it.
 *
 * Everything else is arithmetic on that: round each side to a whole
 * MERGE×PATCH block, shrink if the result is over `maxPixels`, grow if it
 * is under `minPixels`. No padding, no cropping — the aspect ratio moves
 * slightly and that is what the model was trained on.
 */
export function smartResize(
  width: number,
  height: number,
  { minPixels, maxPixels }: Preprocessing = DEFAULT_PREPROCESSING,
): { width: number; height: number } {
  let w = width;
  let h = height;

  // A side thinner than one block is stretched until it is one.
  if (h < FACTOR) {
    w = Math.round((w * FACTOR) / h);
    h = FACTOR;
  }
  if (w < FACTOR) {
    h = Math.round((h * FACTOR) / w);
    w = FACTOR;
  }

  let hBar = Math.round(h / FACTOR) * FACTOR;
  let wBar = Math.round(w / FACTOR) * FACTOR;

  if (hBar * wBar > maxPixels) {
    const beta = Math.sqrt((h * w) / maxPixels);
    hBar = Math.floor(h / beta / FACTOR) * FACTOR;
    wBar = Math.floor(w / beta / FACTOR) * FACTOR;
  } else if (hBar * wBar < minPixels) {
    const beta = Math.sqrt(minPixels / (h * w));
    hBar = Math.ceil((h * beta) / FACTOR) * FACTOR;
    wBar = Math.ceil((w * beta) / FACTOR) * FACTOR;
  }

  const maxSide = PATCH_SIZE * MAX_PATCHES_PER_SIDE;
  return {
    width: Math.max(FACTOR, Math.min(wBar, maxSide)),
    height: Math.max(FACTOR, Math.min(hBar, maxSide)),
  };
}

/**
 * RGB pixels → the flat patch sequence the vision tower eats.
 *
 * Plain row-major over the patch grid, each patch channel-first. That is
 * what the Python's reshape/transpose chain reduces to:
 *
 *   reshape(t, temporal, channel, grid_h, patch, grid_w, patch)
 *   transpose(0, 3, 5, 2, 1, 4, 6)   → (t, grid_h, grid_w, channel, …)
 *
 * The first version of this file emitted patches in 2×2 MERGE blocks, the
 * way Qwen2-VL orders them, because the two models look alike from the
 * outside. Nothing failed: the tower produced the right NUMBER of vectors,
 * the slots matched, and the model calmly read a Russian heading as
 * "2023年1月1日". The merge happens inside the graph; the input is
 * ungrouped.
 */
export function patchify(
  rgb: Uint8Array,
  width: number,
  height: number,
  normalisation: Preprocessing = DEFAULT_PREPROCESSING,
): PatchedImage {
  const gridH = Math.floor(height / PATCH_SIZE);
  const gridW = Math.floor(width / PATCH_SIZE);
  const perPatch = 3 * PATCH_SIZE * PATCH_SIZE;
  const numPatches = gridH * gridW;
  const out = new Float32Array(numPatches * perPatch);

  let p = 0;
  for (let patchRow = 0; patchRow < gridH; patchRow++) {
    for (let patchCol = 0; patchCol < gridW; patchCol++) {
      const base = p * perPatch;
      for (let c = 0; c < 3; c++) {
        const channelBase = base + c * PATCH_SIZE * PATCH_SIZE;
        const mean = normalisation.mean[c];
        const std = normalisation.std[c];
        for (let y = 0; y < PATCH_SIZE; y++) {
          const srcY = patchRow * PATCH_SIZE + y;
          const rowBase = (srcY * width + patchCol * PATCH_SIZE) * 3 + c;
          const dstBase = channelBase + y * PATCH_SIZE;
          for (let x = 0; x < PATCH_SIZE; x++) {
            out[dstBase + x] = (rgb[rowBase + x * 3] / 255 - mean) / std;
          }
        }
      }
      p++;
    }
  }

  return {
    pixelValues: out,
    gridTHW: [1, gridH, gridW],
    numPatches,
    numImageTokens: numPatches / (MERGE_SIZE * MERGE_SIZE),
    width,
    height,
  };
}
