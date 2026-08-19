/**
 * Screen capture for Computer Use.
 *
 * Captures the primary display via Electron's desktopCapturer (no native
 * dependency) in DIP space, so coordinates line up with PowerShell's
 * SetCursorPos (which is not per-monitor-DPI-aware and works in system/DIP
 * pixels). If the display is wider than TARGET_WIDTH the image is downscaled
 * for the model; `scale` maps model coordinates back to DIP screen pixels.
 *
 * Resizing uses Electron's NativeImage (no `sharp` dependency) — fast enough
 * for the occasional screenshot, and keeps the build free of native modules.
 */

import { desktopCapturer, screen } from "electron";

const TARGET_WIDTH = 1280;

export interface ScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Screenshot {
  png: Buffer;
  /** Dimensions of the returned image (what the model sees). */
  width: number;
  height: number;
  /** Map model image coordinates to screen coordinates. */
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  /** Region of the original display represented by the image. */
  region: ScreenshotRegion;
}

export async function captureScreen(
  region?: ScreenshotRegion,
  /** Cap on the returned image's width. The model-facing default keeps
   * screenshots at a size vision models are trained on; the vision fallback
   * passes Infinity — OCR wants every pixel the display has. */
  targetWidth: number = TARGET_WIDTH,
): Promise<Screenshot> {
  const display = screen.getPrimaryDisplay();
  const { width: dipW, height: dipH } = display.size;

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: dipW, height: dipH },
  });
  // The primary display's source id ends with the display id on Windows;
  // fall back to the first screen source.
  const src =
    sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  if (!src) throw new Error("No screen source available to capture.");

  const full = src.thumbnail; // NativeImage at ~DIP size
  const { width: rawW, height: rawH } = full.getSize();
  const hasRegion =
    region !== undefined && region.width > 0 && region.height > 0;
  // desktopCapturer thumbnails may be in physical pixels while input APIs use
  // display coordinates (DIP). Keep the model's coordinate system in DIP.
  const rawScaleX = rawW / dipW;
  const rawScaleY = rawH / dipH;
  const requestedX = hasRegion ? region!.x - display.bounds.x : 0;
  const requestedY = hasRegion ? region!.y - display.bounds.y : 0;
  const requestedWidth = hasRegion ? region!.width : dipW;
  const requestedHeight = hasRegion ? region!.height : dipH;
  const dipRegion = {
    x: Math.max(0, Math.min(Math.floor(requestedX), dipW - 1)),
    y: Math.max(0, Math.min(Math.floor(requestedY), dipH - 1)),
    width: Math.max(1, Math.min(Math.floor(requestedWidth), dipW)),
    height: Math.max(1, Math.min(Math.floor(requestedHeight), dipH)),
  };
  dipRegion.width = Math.min(dipRegion.width, dipW - dipRegion.x);
  dipRegion.height = Math.min(dipRegion.height, dipH - dipRegion.y);
  const rawRegion = {
    x: Math.floor(dipRegion.x * rawScaleX),
    y: Math.floor(dipRegion.y * rawScaleY),
    width: Math.max(1, Math.floor(dipRegion.width * rawScaleX)),
    height: Math.max(1, Math.floor(dipRegion.height * rawScaleY)),
  };
  let img = full.crop(rawRegion);
  let outW = rawRegion.width;
  let outH = rawRegion.height;

  if (outW > targetWidth) {
    const resizedW = targetWidth;
    const resizedH = Math.round(outH * resizedW / outW);
    img = img.resize({ width: resizedW, height: resizedH });
    outW = resizedW;
    outH = resizedH;
  }

  return {
    png: img.toPNG(),
    width: outW,
    height: outH,
    scaleX: dipRegion.width / outW,
    scaleY: dipRegion.height / outH,
    offsetX: display.bounds.x + dipRegion.x,
    offsetY: display.bounds.y + dipRegion.y,
    region: {
      x: display.bounds.x + dipRegion.x,
      y: display.bounds.y + dipRegion.y,
      width: dipRegion.width,
      height: dipRegion.height,
    },
  };
}

/** Convert model-image coordinates to virtual desktop coordinates. */
/**
 * The point handed to the INPUT layer, from a point in the tool's space.
 *
 * The tool's whole space is DIP — screenshots, the accessibility tree and the
 * vision fallback all report there. Windows' input layer is per-monitor-DPI
 * aware and wants physical pixels, so Electron converts; every other platform
 * already speaks the same units and must pass through UNCHANGED.
 *
 * It lives here, as one function, because it was once inline in the tool and
 * the macOS branch simply forgot to assign — every click went to [0, 0] and
 * the pointer sat in the corner of the screen. A pass-through is easy to omit
 * when it is spelled as "do nothing".
 */
export function toInputPoint(p: { x: number; y: number }): { x: number; y: number } {
  if (process.platform !== "win32") return { x: p.x, y: p.y };
  const phys = screen.dipToScreenPoint({ x: p.x, y: p.y });
  return { x: phys.x, y: phys.y };
}

/** The inverse of toInputPoint: a point from the input layer, in the tool's
 * space. Same rule, same reason — screenToDipPoint is Windows-only too. */
export function fromInputPoint(p: { x: number; y: number }): { x: number; y: number } {
  if (process.platform !== "win32") return { x: p.x, y: p.y };
  const dip = screen.screenToDipPoint({ x: p.x, y: p.y });
  return { x: dip.x, y: dip.y };
}

export function toScreenCoord(
  x: number,
  y: number,
  scaleX: number,
  scaleY: number,
  offsetX: number,
  offsetY: number,
): { x: number; y: number } {
  return {
    x: Math.round(offsetX + x * scaleX),
    y: Math.round(offsetY + y * scaleY),
  };
}
