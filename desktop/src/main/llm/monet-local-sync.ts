/**
 * Keeping a Monet Local provider's model list true while the app is open.
 *
 * Every other provider's catalogue is fixed: the models a key gives access to
 * do not change between one glance at the picker and the next. Monet Local's
 * do, and that is the point of it — loading is a decision made over there, in
 * front of a memory estimate, and a model that has been unloaded must stop
 * being offered here. Offering it anyway means the next request either fails
 * or triggers a multi-minute load nobody asked for.
 *
 * `hasDynamicModels` said this was the intent; nothing acted on it, so the
 * list was whatever the settings dialog last wrote and never moved again.
 *
 * Only a successful read writes. "It told me nothing is loaded" is news and
 * empties the list; "I could not reach it" is not, and leaves what is stored
 * alone — a server that is merely off should not churn the ids, the hidden
 * flags, and the composer's current pick every ten seconds.
 */

import { getProviderManager } from "../provider/manager.js";
import { hasDynamicModels, type ProviderModel } from "../provider/types.js";
import { fetchProviderModels, type DiscoveredModel } from "./fetch-models.js";

const EVERY_MS = 10_000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * What the server knows wins; everything else is the user's and survives.
 *
 * This runs every ten seconds and REPLACES the stored list, so anything not
 * carried across here is not merely lost — it is lost silently, moments after
 * being typed. That was true of every per-model setting: a max_tokens raised
 * by hand, a temperature, the per-model silence timeout. Keyed by name, since
 * the ids on this side are generated.
 *
 * Exported for the smoke probe — this and `same` are the whole behaviour, and
 * the rest of this module is the storage they act on.
 */
export function merge(
  previous: ProviderModel[],
  found: DiscoveredModel[],
): ProviderModel[] {
  return found.map((m) => {
    const old = previous.find((p) => p.name === m.name);
    return {
      id: old?.id ?? `m_${Math.random().toString(36).slice(2, 10)}`,
      name: m.name,
      ...(m.label ? { label: m.label } : old?.label ? { label: old.label } : {}),
      ...(m.contextLength ? { contextLength: m.contextLength } : {}),
      // The server's own ceiling on one answer (--n-predict) when it reports
      // one. Without it this side asked for its default 16000 tokens no
      // matter what the model was configured to give.
      ...(m.maxOutputTokens
        ? { maxOutputTokens: m.maxOutputTokens }
        : old?.maxOutputTokens !== undefined
          ? { maxOutputTokens: old.maxOutputTokens }
          : {}),
      // The server's own ladder, which is the only place the real one is
      // known — see @shared/effort.ts for what a wrong ladder costs.
      ...(m.effortLevels?.length
        ? { effortLevels: m.effortLevels }
        : old?.effortLevels?.length
          ? { effortLevels: old.effortLevels }
          : {}),
      ...(m.modalities ? { modalities: m.modalities } : {}),
      ...(m.supportsEffort !== undefined
        ? { supportsEffort: m.supportsEffort }
        : {}),
      // Nothing below is discoverable — it is what the user set on this
      // model, and a reading of what is loaded has no business erasing it.
      ...(old?.maxInputTokens !== undefined
        ? { maxInputTokens: old.maxInputTokens }
        : {}),
      ...(old?.temperature !== undefined ? { temperature: old.temperature } : {}),
      ...(old?.streamTimeoutSec !== undefined
        ? { streamTimeoutSec: old.streamTimeoutSec }
        : {}),
      ...(old?.baseURL ? { baseURL: old.baseURL } : {}),
      ...(old?.routing ? { routing: old.routing } : {}),
      ...(old?.hidden ? { hidden: true } : {}),
    };
  });
}

/** Compared on what a request is built from — not on the generated ids. */
export function same(a: ProviderModel[], b: ProviderModel[]): boolean {
  const key = (m: ProviderModel): string =>
    [
      m.name,
      m.label ?? "",
      m.contextLength ?? "",
      m.maxOutputTokens ?? "",
      (m.effortLevels ?? []).join("+"),
      m.maxInputTokens ?? "",
      m.temperature ?? "",
      m.streamTimeoutSec ?? "",
      (m.modalities ?? []).join("+"),
      m.supportsEffort ?? "",
      m.hidden ?? false,
    ].join("|");
  return a.length === b.length && a.every((m, i) => key(m) === key(b[i]!));
}

export async function syncDynamicProviders(): Promise<void> {
  const pm = getProviderManager();
  for (const p of pm.list()) {
    if (!hasDynamicModels(p.kind)) continue;
    let found: DiscoveredModel[];
    try {
      found = await fetchProviderModels(p.baseURL, p.apiKey ?? "", p.kind);
    } catch {
      // Unreachable is not an answer. Leave the stored list as it is.
      continue;
    }
    const next = merge(p.models ?? [], found);
    if (same(p.models ?? [], next)) continue;
    pm.update(p.id, { ...p, models: next });
  }
}

/**
 * Poll rather than subscribe. Monet Local does broadcast `models-changed` on
 * its own event stream, but a ten-second GET against a server on this machine
 * costs nothing and needs no reconnection logic to be right after a sleep, a
 * restart of Monet Local, or a network that came and went.
 */
export function startDynamicModelSync(): void {
  if (timer) return;
  void syncDynamicProviders();
  timer = setInterval(() => void syncDynamicProviders(), EVERY_MS);
  // Never hold the process open for this.
  timer.unref?.();
}

export function stopDynamicModelSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
