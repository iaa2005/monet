/**
 * Screen capture for Computer Use.
 *
 * Captures the primary display via Electron's desktopCapturer (no native
 * dependency) in DIP space, so coordinates line up with PowerShell's
 * SetCursorPos (which is not per-monitor-DPI-aware and works in system/DIP
 * pixels). If the display is wider than TARGET_WIDTH the image is downscaled
 * for the model; `scale` maps model coordinates back to DIP screen pixels.
 */

import { desktopCapturer, screen } from "electron";
import sharp from "sharp";

const TARGET_WIDTH = 1280;

export interface Screenshot {
  png: Buffer;
  /** Dimensions of the returned image (what the model sees). */
  width: number;
  height: number;
  /** Multiply model image coords by this to get DIP screen coords. */
  scale: number;
}

export async function captureScreen(): Promise<Screenshot> {
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
  const size = full.getSize();
  let png = full.toPNG();
  let outW = size.width;
  let outH = size.height;
  let scale = 1;

  if (size.width > TARGET_WIDTH) {
    scale = size.width / TARGET_WIDTH;
    outW = TARGET_WIDTH;
    outH = Math.round(size.height / scale);
    png = await sharp(png).resize(outW, outH).png().toBuffer();
  }

  return { png, width: outW, height: outH, scale };
}

/** Convert a coordinate the model gave (in the returned image's space) to a
 * DIP screen coordinate for the input layer. */
export function toScreenCoord(
  x: number,
  y: number,
  scale: number,
): { x: number; y: number } {
  return { x: Math.round(x * scale), y: Math.round(y * scale) };
}
