/**
 * The feature flags, on disk — `<dataDir>/agent-features.json`.
 *
 * A plain readable file beside the app's other settings, for the same
 * reason ui-prefs.json is one: it can be inspected, backed up with the data
 * folder and edited by hand. Everything read out of it is sanitised rather
 * than trusted.
 *
 * `isFeatureOn` is deliberately cheap and synchronous — it is called on the
 * agent's hot path (once per turn, sometimes per tool batch), and a flag
 * that costs a promise to read would be a flag people notice.
 *
 * NOT a cache: the file is small and the OS caches it, while a cached copy
 * would mean a toggle in Settings does nothing until restart — which is
 * exactly what the toggle promises not to do.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import {
  defaultFeatures,
  sanitiseFeatures,
  type FeatureFlags,
  type FeatureId,
} from "@shared/agent-features.js";

function filePath(): string {
  return join(getDataDir(), "agent-features.json");
}

export function getFeatures(): FeatureFlags {
  try {
    const p = filePath();
    if (!existsSync(p)) return defaultFeatures();
    return sanitiseFeatures(JSON.parse(readFileSync(p, "utf-8")));
  } catch {
    // A hand-edited file with a stray comma costs the flags, not the run.
    return defaultFeatures();
  }
}

/** Merge a patch in and write it back. Merged, so a screen that only knows
 * about one switch cannot erase the others. */
export function setFeatures(patch: Partial<FeatureFlags>): FeatureFlags {
  const next = { ...getFeatures(), ...patch };
  try {
    writeFileSync(filePath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    // A read-only data folder is not worth breaking the agent over.
  }
  return next;
}

/** The hot-path question: is this one on right now? */
export function isFeatureOn(id: FeatureId): boolean {
  return getFeatures()[id];
}
