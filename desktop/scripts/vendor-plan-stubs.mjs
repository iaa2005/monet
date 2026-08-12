/**
 * The stubs were never Anthropic's — they are ours.
 *
 * The leak is partial: it has no terminal renderer, so around fifty modules
 * the engine imports (Ink primitives, message components, select widgets,
 * keybinding types) simply are not in it. Our own fill-vendor script wrote
 * placeholders so tsc and vite could resolve those names — nine-line files
 * exporting `(() => null) as any`.
 *
 * When the tree was split, those placeholders went to src/anthropic along
 * with everything else that sat under components/ and ink/. That put 138 of
 * the 259 remaining edges into the quarantine — and every one of them points
 * at a file WE generated, containing no Anthropic code at all.
 *
 * They move to src/main/engine/stubs, keeping their subpaths so an import
 * still reads as what it stands in for.
 *
 * FILES is a function so the set is COMPUTED from the AUTO-STUB marker rather
 * than transcribed. A hand-copied list of fifty paths is a list that is wrong
 * by the time it is read.
 */
import { readFileSync } from "fs";
import { join, resolve } from "path";

const QUARANTINE = resolve(process.cwd(), "src/anthropic");

export function FILES(all) {
  return all
    .filter((rel) => {
      try {
        return readFileSync(join(QUARANTINE, rel), "utf8").includes("AUTO-STUB");
      } catch {
        return false;
      }
    })
    .map((rel) => [rel, "main/engine/stubs/" + rel]);
}
