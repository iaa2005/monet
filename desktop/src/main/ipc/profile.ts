/** Profile IPC — Settings → General profile block. */

import { ipcMain } from "electron";
import {
  avatarDataUrl,
  getProfile,
  listGallery,
  setAvatarFromFile,
  setAvatarFromUrl,
  setProfile,
  type Profile,
} from "../profile.js";

export function registerProfileIPC(): void {
  ipcMain.handle("profile:get", () => ({
    ...getProfile(),
    avatarDataUrl: avatarDataUrl(),
  }));
  ipcMain.handle("profile:set", (_e, patch: Partial<Profile>) =>
    setProfile(patch),
  );
  ipcMain.handle("profile:setAvatarFile", (_e, path: string) =>
    setAvatarFromFile(path),
  );
  ipcMain.handle("profile:setAvatarUrl", (_e, url: string) =>
    setAvatarFromUrl(url),
  );
  ipcMain.handle(
    "profile:gallery",
    async (): Promise<{
      ok: boolean;
      items?: { url: string; dataUrl: string }[];
      error?: string;
    }> => {
      try {
        return { ok: true, items: await listGallery() };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "gallery failed",
        };
      }
    },
  );
}
