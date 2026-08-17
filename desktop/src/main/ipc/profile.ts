/** Profile IPC — Settings → General profile block. */

import { ipcMain } from "electron";
import { getMainWindow } from "../app/main-window.js";
import {
  avatarDataUrl,
  getProfile,
  listPaintings,
  paintingImage,
  pickGalleryAvatar,
  setAvatarFromFile,
  setProfile,
  type Profile,
} from "../app/profile.js";

function notifyRenderer(): void {
  const win = getMainWindow();
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
    const r = await pickGalleryAvatar(file);
    if (r.ok) notifyRenderer();
    return r;
  });
}
