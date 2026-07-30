/**
 * What the active model can actually take as input.
 *
 * Its own module because both the toolset (which decides what to advertise)
 * and individual tools (which decide what to put in a result) need it, and the
 * toolset imports the tools. One shared leaf beats an import cycle.
 */

import { getProviderManager } from "../provider/manager.js";
import { inferModalities, type Modality } from "../provider/types.js";

/** Declared modalities, else inferred from the provider kind and model id. */
export function activeModelAccepts(modality: Modality): boolean {
  const active = getProviderManager().getActive();
  if (!active) return false;
  const mods =
    active.modalities ?? inferModalities(active.kind, active.model ?? "");
  return mods.includes(modality);
}
