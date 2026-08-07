/**
 * The preferences the UI keeps between launches, as a file you can read.
 *
 * `<dataDir>/ui-prefs.json`, alongside stt.json, ocr.json and the rest —
 * the app's own convention for "a setting that outlives the window". The
 * first version of this put the sessions-list filters in localStorage,
 * which works in a packaged build (the renderer is a stable `file://`
 * origin) and does NOT in dev, where the origin carries vite's port and
 * the port moves. The same trap already cost the dictation settings once.
 *
 * A file also means it can be inspected, backed up with the data folder,
 * and edited by hand — which is why everything read out of it is
 * sanitised rather than trusted.
 *
 * Deliberately not `ui-state.json`: that one is per-SESSION layout, keyed
 * by session id. These are global.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import {
  sanitiseFilters,
  type SessionFilters,
} from "../../shared/session-filters.js";
import { sanitiseComposerHeight } from "../../shared/composer-height.js";

export interface UiPrefs {
  /** How the sessions list is filtered, sorted and drawn. */
  sessionFilters: SessionFilters;
  /** The height the user dragged the message box to, or null to let it
   * grow with the text. */
  composerHeight: number | null;
}

function prefsPath(): string {
  return join(getDataDir(), "ui-prefs.json");
}

function readFile(): Record<string, unknown> {
  try {
    const p = prefsPath();
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    // A hand-edited file with a stray comma should cost the preferences,
    // not the window that reads them.
    return {};
  }
}

export function getUiPrefs(): UiPrefs {
  const raw = readFile();
  return {
    sessionFilters: sanitiseFilters(raw["sessionFilters"]),
    composerHeight: sanitiseComposerHeight(raw["composerHeight"]),
  };
}

/**
 * Merge a patch in and write it back.
 *
 * Merged rather than replaced: the renderer that saves the sessions
 * filters should not have to know what else lives in this file, and the
 * next preference added here should not be erased by an older screen that
 * has not heard of it.
 */
export function setUiPrefs(patch: Partial<UiPrefs>): UiPrefs {
  const current = readFile();
  const next: Record<string, unknown> = { ...current };
  if (patch.sessionFilters)
    next["sessionFilters"] = sanitiseFilters(patch.sessionFilters);
  // Present-but-null is how the composer says "go back to growing with the
  // text", so this one is keyed on the property existing, not on truthiness.
  if ("composerHeight" in patch)
    next["composerHeight"] = sanitiseComposerHeight(patch.composerHeight);
  try {
    writeFileSync(prefsPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    // A read-only data folder is not worth breaking the UI over.
  }
  return {
    sessionFilters: sanitiseFilters(next["sessionFilters"]),
    composerHeight: sanitiseComposerHeight(next["composerHeight"]),
  };
}
