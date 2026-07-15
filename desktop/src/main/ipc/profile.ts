/** Profile IPC — Settings → General profile block. */

import { BrowserWindow, ipcMain } from "electron";
import {
  avatarDataUrl,
  avatarRawUrl,
  getProfile,
  listGallery,
  listPaintings,
  paintingImage,
  setAvatarFromFile,
  setAvatarFromUrl,
  setProfile,
  type Profile,
} from "../profile.js";

function notifyRenderer(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win)
    win.webContents.send("profile:changed", {
      ...getProfile(),
      avatarDataUrl: avatarDataUrl(),
    });
}

export function registerProfileIPC(): void {
  ipcMain.handle("profile:get", () => ({
    ...getProfile(),
    avatarDataUrl: avatarDataUrl(),
  }));
  ipcMain.handle("profile:set", (_e, patch: Partial<Profile>) => {
    const next = setProfile(patch);
    notifyRenderer();
    return next;
  });
  ipcMain.handle("profile:setAvatarFile", (_e, path: string) => {
    const r = setAvatarFromFile(path);
    if (r.ok) notifyRenderer();
    return r;
  });
  ipcMain.handle("profile:setAvatarUrl", async (_e, url: string) => {
    const r = await setAvatarFromUrl(url);
    if (r.ok) notifyRenderer();
    return r;
  });
  ipcMain.handle("profile:paintings", async () => {
    try {
      return { ok: true, items: await listPaintings() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "failed" };
    }
  });
  ipcMain.handle("profile:paintingImage", async (_e, file: string) => {
    try {
      return { ok: true, dataUrl: await paintingImage(file) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "failed" };
    }
  });
  ipcMain.handle("profile:pickPaintingFace", async (_e, file: string) => {
    const r = await setAvatarFromUrl(avatarRawUrl(file));
    if (r.ok) notifyRenderer();
    return r;
  });
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
