/**
 * Reading a voice style off disk, and its map.
 *
 * The presets carry their map in the catalogue (so a voice has a picture
 * before it is downloaded); anything imported or blended gets one computed
 * here. Cached by size and mtime, because the status call that needs it runs
 * whenever the settings open and a style file is 290 KB of JSON numbers.
 */

import { readFileSync, statSync } from "fs";
import { styleMap } from "@shared/voice-map.js";

export interface StyleTensors {
  /** Flattened row-major, 50 × 256. */
  ttl: number[];
  /** Flattened row-major, 8 × 16. */
  dp: number[];
}

function flatten(x: unknown): number[] {
  return Array.isArray(x) ? (x.flat(Infinity) as number[]) : [];
}

export function readStyleFile(path: string): StyleTensors | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const ttl = flatten((j.style_ttl as { data?: unknown } | undefined)?.data);
    const dp = flatten((j.style_dp as { data?: unknown } | undefined)?.data);
    if (!ttl.length || !dp.length) return null;
    return { ttl, dp };
  } catch {
    return null;
  }
}

const cache = new Map<string, { size: number; mtimeMs: number; hex: string | null }>();

export function styleMapOf(path: string): string | null {
  try {
    const s = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) return hit.hex;
    const style = readStyleFile(path);
    const hex = style ? styleMap(style.ttl) : null;
    cache.set(path, { size: s.size, mtimeMs: s.mtimeMs, hex });
    return hex;
  } catch {
    return null;
  }
}
