/**
 * Opening an artifact — the two verbs, in a module with no components in it.
 *
 * They used to live in FileCard and be re-exported by ArtifactsPanel, which
 * made both of those files export something that is not a component. React
 * Fast Refresh then refuses to hot-update them ("export is incompatible") and
 * falls back to reloading the page, so every edit to a card threw away the
 * conversation on screen. A leaf module fixes it for both.
 */

import type { ElectronAPI } from "@/types/electron";
import { useChatStore } from "@/stores/chatStore";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** Hand the file to the OS. */
export function openArtifact(path?: string): void {
  if (path) void api()?.artifacts.open(path);
}

/** Open a file in the in-app viewer. */
export function viewArtifact(a: {
  name: string;
  path?: string;
  mediaType: string;
  kind: string;
  dataUrl?: string;
}): void {
  useChatStore.getState().openViewer({ ...a, source: "artifact" });
}
