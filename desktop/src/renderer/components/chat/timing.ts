/**
 * The words after a turn's Copy button: how long it took, how fast it wrote.
 *
 *   2d 1h 34m · 6.8 tok/s
 *   23m 34s · 41 tok/s
 *   4s · 112 tok/s
 *
 * Two or three units, never four — "1h 2m 3s" is more digits than a person
 * reads. Seconds appear only under an hour; under ten seconds they keep one
 * decimal, because "0s" for a reply that took 400 ms says the clock is broken.
 */
import type { MessageTiming } from "@/types/chat";

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSec = ms / 1000;
  if (totalSec < 10) return `${totalSec.toFixed(1)}s`;
  const s = Math.floor(totalSec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Tokens over the model's WRITING time; null when either half is unknown. */
export function formatSpeed(t: MessageTiming): string | null {
  if (!(t.generationMs > 0) || !(t.outputTokens > 0)) return null;
  const tps = t.outputTokens / (t.generationMs / 1000);
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`;
}

/** The whole line, or null when there is nothing worth saying. */
export function formatTiming(t: MessageTiming | undefined): string | null {
  if (!t) return null;
  const parts = [formatDuration(t.elapsedMs), formatSpeed(t)].filter(
    (x): x is string => !!x,
  );
  return parts.length ? parts.join(" · ") : null;
}
