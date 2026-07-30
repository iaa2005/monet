/**
 * The list of agents whose folders a repository might use, from the catalogue.
 *
 * pbakaus/impeccable alone ships fifteen, and six of them (.grok, .pi, .qoder,
 * .rovodev, .trae-cn, .vibe) are not on any published list of coding agents.
 * New ones will keep appearing, and giving a folder a name should not need a
 * release — so the list lives in the repo, per the standing rule that anything
 * that changes goes there.
 *
 * The app's own list is the floor and cannot be overridden: a catalogue entry
 * for a folder we already know is dropped, and every catalogue entry ranks after
 * every built-in. So this file can name a folder and pick its icon; it can never
 * make the app prefer another agent's copy of a skill over ours.
 */

import { parseAgentFolders, setExtraAgentFolders } from "./agent-folders.js";
import { fetchRetry } from "./net-fetch.js";

const URL_ =
  "https://raw.githubusercontent.com/iaa2005/monet-directory/main/agent-folders.json";

/** A day. New agents appear in weeks, not minutes. */
const CACHE_MS = 24 * 60 * 60 * 1000;

let at = 0;
let loading: Promise<void> | null = null;

/**
 * Load once, then leave it alone.
 *
 * Called before resolving a folder, so it must never throw and never block for
 * long: no file is the normal state, and an install must not fail because
 * GitHub is slow.
 */
export async function loadAgentFolders(): Promise<void> {
  if (Date.now() - at < CACHE_MS) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetchRetry(URL_, {
        headers: { "User-Agent": "monet-desktop" },
      });
      if (!res.ok) throw new Error(String(res.status));
      const { agents, rejected } = parseAgentFolders(await res.json());
      if (rejected.length)
        console.warn(
          `[agents] ignored ${rejected.length} catalogue entr(ies): ${rejected.join("; ")}`,
        );
      setExtraAgentFolders(agents);
      at = Date.now();
    } catch {
      // Keep whatever is loaded — including nothing, which is a working state.
    } finally {
      loading = null;
    }
  })();
  return loading;
}
