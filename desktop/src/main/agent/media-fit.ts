/**
 * Fitting an image into what a model will accept.
 *
 * Pure decisions here, pixels elsewhere: given the original size in bytes and
 * pixels, work out whether to send it untouched, crop it, downsample it, or
 * refuse. Kept apart from Electron's nativeImage so the arithmetic — which is
 * where the off-by-a-factor bugs live — can be tested without a display.
 *
 * The refusal matters as much as the resize. Kimi Code's rule, copied here: if
 * automatic compression cannot safely reach the limit, return an ERROR and do
 * not send the original. A silently over-budget image comes back as a provider
 * error the model cannot interpret; an explicit "make a smaller copy and read
 * that" is something it can act on.
 */

/** Longest edge, in pixels, of an image handed to a model. */
export const MAX_EDGE_PX = 2000;

/** Byte budget for one model-initiated image read (before base64 inflation). */
export const READ_BYTE_BUDGET = 256 * 1024;

/** Hard ceiling on the file this tool will even open. */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export interface Size {
  width: number;
  height: number;
}

export interface Region extends Size {
  x: number;
  y: number;
}

export type FitPlan =
  | { kind: "as-is"; reason: "within-limits" }
  | { kind: "crop"; region: Region }
  | { kind: "downsample"; to: Size; scale: number }
  | { kind: "refuse"; message: string };

/** Longest-edge scale factor to fit `max`, never above 1 (no upscaling). */
export function scaleToFit(size: Size, maxEdge: number): number {
  const longest = Math.max(size.width, size.height);
  if (longest <= maxEdge) return 1;
  return maxEdge / longest;
}

export function scaledSize(size: Size, scale: number): Size {
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/**
 * Clamp a requested crop to the image.
 *
 * A model computing a region from a downsampled copy will sometimes hand back
 * coordinates that run past the edge. Clamping beats refusing: the crop it
 * wanted is still mostly there. Returns null only when the rectangle misses
 * the image entirely, which is a real mistake worth reporting.
 */
export function clampRegion(region: Region, size: Size): Region | null {
  const x = Math.max(0, Math.min(Math.round(region.x), size.width - 1));
  const y = Math.max(0, Math.min(Math.round(region.y), size.height - 1));
  const width = Math.min(Math.round(region.width), size.width - x);
  const height = Math.min(Math.round(region.height), size.height - y);
  if (width <= 0 || height <= 0) return null;
  if (region.x >= size.width || region.y >= size.height) return null;
  return { x, y, width, height };
}

/**
 * What to do with this image.
 *
 * `fullResolution` is the model's way of saying "I need the detail" — honoured
 * only when the file already fits the byte budget, because the alternative is
 * sending something the provider will reject.
 */
export function planFit(opts: {
  bytes: number;
  size: Size;
  region?: Region;
  fullResolution?: boolean;
  maxEdgePx?: number;
  byteBudget?: number;
}): FitPlan {
  const maxEdge = opts.maxEdgePx ?? MAX_EDGE_PX;
  const budget = opts.byteBudget ?? READ_BYTE_BUDGET;

  if (opts.region) {
    const clamped = clampRegion(opts.region, opts.size);
    if (!clamped)
      return {
        kind: "refuse",
        message:
          `The region ${opts.region.x},${opts.region.y} ${opts.region.width}x${opts.region.height} ` +
          `falls outside the image (${opts.size.width}x${opts.size.height}). ` +
          `Region coordinates are in the ORIGINAL image's pixel space.`,
      };
    return { kind: "crop", region: clamped };
  }

  const withinPixels = Math.max(opts.size.width, opts.size.height) <= maxEdge;

  if (opts.fullResolution) {
    if (opts.bytes <= budget) return { kind: "as-is", reason: "within-limits" };
    return {
      kind: "refuse",
      message:
        `full_resolution was requested but the file is ${kb(opts.bytes)}, over the ` +
        `${kb(budget)} per-image budget. Read a REGION of it instead, or make a ` +
        `smaller copy and read that.`,
    };
  }

  if (withinPixels && opts.bytes <= budget)
    return { kind: "as-is", reason: "within-limits" };

  const scale = scaleToFit(opts.size, maxEdge);
  if (scale < 1)
    return { kind: "downsample", to: scaledSize(opts.size, scale), scale };

  // Already small enough in pixels but still over the byte budget — a dense
  // photo. Re-encoding at a lower quality is the encoder's job; ask for it by
  // planning a no-op downsample at the current size.
  return { kind: "downsample", to: opts.size, scale: 1 };
}

function kb(n: number): string {
  return `${Math.round(n / 1024)} KB`;
}

/**
 * The `<system>` note that travels with the image.
 *
 * It exists so the model can convert what it sees back to the real thing: a
 * coordinate read off a downsampled copy is wrong by exactly the scale factor,
 * and the only defence is stating the original dimensions every time.
 */
export function describeDelivery(opts: {
  path: string;
  mediaType: string;
  bytes: number;
  original: Size;
  plan: FitPlan;
  delivered?: Size;
}): string {
  const head = `<system>${opts.path} — ${opts.mediaType}, ${kb(opts.bytes)}, original ${opts.original.width}x${opts.original.height}px.`;
  const tail = "</system>";
  switch (opts.plan.kind) {
    case "as-is":
      return `${head} Delivered untouched.${tail}`;
    case "crop": {
      const r = opts.plan.region;
      return (
        `${head} Delivered as a CROP at native resolution: region ${r.x},${r.y} ` +
        `${r.width}x${r.height} of the original. Coordinates you read here are ` +
        `offset by ${r.x},${r.y} from the original.${tail}`
      );
    }
    case "downsample": {
      const to = opts.delivered ?? opts.plan.to;
      return (
        `${head} DOWNSAMPLED to ${to.width}x${to.height}px (x${opts.plan.scale.toFixed(3)}). ` +
        `Fine detail may be lost. Give relative coordinates first and multiply by ` +
        `the ORIGINAL size above — never measure off this copy. For detail, call ` +
        `again with region (original pixel coordinates) or full_resolution.${tail}`
      );
    }
    case "refuse":
      return `${head} NOT delivered: ${opts.plan.message}${tail}`;
  }
}
