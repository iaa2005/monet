/**
 * Does this [[wikilink]] point at a real note? — answered without hurting
 * anything.
 *
 * The danger is volume: a streaming reply re-renders constantly and one
 * message can carry dozens of chips. Per-chip IPC on every render would be
 * the glitch factory Sasha explicitly asked to avoid. So the contract is:
 *
 *   - a MODULE-LEVEL cache (60 s TTL) answers repeat questions
 *     synchronously — re-renders cost zero IPC;
 *   - unknown refs go into a queue that flushes as ONE batched call per
 *     150 ms window, however many chips mounted;
 *   - subscribers are plain callbacks with cleanup — an unmounted chip is
 *     forgotten, never set-stated;
 *   - every failure path resolves to "ok": a broken bridge must render
 *     links normally, not paint the whole chat grey.
 */

import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export type VaultRefStatus = "ok" | "missing";

const TTL_MS = 60_000;
const FLUSH_MS = 150;

const cache = new Map<string, { ok: boolean; at: number }>();
const queue = new Map<string, Set<(s: VaultRefStatus) => void>>();
let timer: ReturnType<typeof setTimeout> | null = null;

const keyOf = (ref: string): string => ref.trim().toLowerCase();

async function flush(): Promise<void> {
  timer = null;
  const batch = [...queue.entries()];
  queue.clear();
  if (batch.length === 0) return;
  let result: Record<string, boolean> = {};
  try {
    result = (await api()?.obsidian.exists(batch.map(([ref]) => ref))) ?? {};
  } catch {
    /* bridge down — fall through to the optimistic default below */
  }
  const now = Date.now();
  for (const [ref, subs] of batch) {
    const ok = result[ref] ?? true;
    cache.set(keyOf(ref), { ok, at: now });
    for (const cb of subs) cb(ok ? "ok" : "missing");
  }
}

/**
 * Ask about one ref. Returns the cached verdict synchronously when fresh,
 * else null — and the callback fires exactly once after the next batch.
 * The returned function unsubscribes (unmount safety).
 */
export function vaultRefStatus(
  ref: string,
  cb: (s: VaultRefStatus) => void,
): { cached: VaultRefStatus | null; cancel: () => void } {
  const hit = cache.get(keyOf(ref));
  if (hit && Date.now() - hit.at < TTL_MS)
    return { cached: hit.ok ? "ok" : "missing", cancel: () => {} };
  let subs = queue.get(ref);
  if (!subs) {
    subs = new Set();
    queue.set(ref, subs);
  }
  subs.add(cb);
  if (!timer) timer = setTimeout(() => void flush(), FLUSH_MS);
  return {
    cached: null,
    cancel: () => {
      subs.delete(cb);
    },
  };
}
