/**
 * OCR Scanner IPC — Settings → OCR Scanner.
 *
 * Installing or switching a model changes what the agent is offered (the
 * OCRScan tool only exists when a model is installed), so every mutation
 * refreshes the vendor toolset the way Memory's and Obsidian's toggles do.
 */

import { BrowserWindow, dialog, ipcMain } from "electron";
import {
  formatBytes,
  OCR_MODELS,
  ocrModel,
  type OcrDtype,
  type OcrModelInfo,
} from "../ocr/catalog.js";
import { LAYOUT_FILE, LAYOUT_REPO } from "../ocr/layout.js";
import { DET_FILE, DET_REPO } from "../ocr/lines/detect.js";
import {
  bytesOnDisk,
  cancelOcrInstall,
  hasLayoutFile,
  installLayoutModel,
  installOcrModel,
  isInstalled,
  isInstalling,
  removeOcrModel,
} from "../ocr/install.js";
import { getOcrConfig, setOcrConfig, type OcrConfig } from "../ocr/settings.js";
import { disposeOcrEngine } from "../ocr/engine.js";
import { canScan, scanDocument } from "../ocr/scan.js";
import { resetVendorTools } from "../agent/vendor-tools.js";

export interface UiOcrVariant {
  dtype: OcrDtype;
  bytes: number;
  size: string;
  devices: string[];
  note: string;
  installed: boolean;
  onDisk: number;
  installing: boolean;
}

export interface UiOcrModel {
  id: string;
  label: string;
  /** One line for the settings page — the long note stays in the model file. */
  short: string;
  note: string;
  languages: string;
  repo: string;
  /** Measured seconds for a typical page, when it has been measured. */
  secondsPerPage?: number;
  variants: UiOcrVariant[];
}

async function toUi(m: OcrModelInfo): Promise<UiOcrModel> {
  const variants: UiOcrVariant[] = [];
  for (const v of m.variants) {
    variants.push({
      dtype: v.dtype,
      bytes: v.bytes,
      size: formatBytes(v.bytes),
      devices: v.devices,
      note: v.note,
      installed: await isInstalled(m, v.dtype),
      onDisk: await bytesOnDisk(m, v.dtype),
      installing: isInstalling(m.id, v.dtype),
    });
  }
  return {
    id: m.id,
    label: m.label,
    short: m.short,
    secondsPerPage: m.secondsPerPage,
    note: m.note,
    languages: m.languages,
    repo: m.repo,
    variants,
  };
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

export function registerOcrIPC(): void {
  ipcMain.handle("ocr:models", async (): Promise<UiOcrModel[]> => {
    const out: UiOcrModel[] = [];
    for (const m of OCR_MODELS) out.push(await toUi(m));
    return out;
  });

  ipcMain.handle("ocr:config", (): OcrConfig => getOcrConfig());

  // The block finder is its own install: 124 MB that turns four minutes a
  // page into twenty seconds, and the difference between "reads documents"
  // and "reads documents usefully".
  ipcMain.handle("ocr:layoutStatus", () => ({
    repo: LAYOUT_REPO,
    installed:
      hasLayoutFile(LAYOUT_REPO, LAYOUT_FILE) && hasLayoutFile(DET_REPO, DET_FILE),
    bytes: 129 * 1024 * 1024,
    size: formatBytes(129 * 1024 * 1024),
  }));

  ipcMain.handle("ocr:installLayout", async () => {
    const r = await installLayoutModel(LAYOUT_REPO, LAYOUT_FILE, (p) =>
      broadcast("ocr:installProgress", p),
    );
    if (!r.ok) return r;
    // And the line detector, 4.6 MB, which nothing was fetching. The code
    // that reads it is complete — it is what measures how crooked a scan
    // is so the page can be straightened — but it guards on the file being
    // present and silently returns "not crooked" when it is not. So on
    // every clean install, deskewing was off and nothing said so.
    const lines = await installLayoutModel(DET_REPO, DET_FILE, (p) =>
      broadcast("ocr:installProgress", p),
    );
    if (lines.ok) resetVendorTools();
    return lines;
  });

  ipcMain.handle("ocr:setConfig", (_e, patch: Partial<OcrConfig>): OcrConfig => {
    const before = getOcrConfig();
    const next = setOcrConfig(patch);
    // The child holds one model at one precision on one device. Any of those
    // changing means the loaded one is the wrong one.
    if (
      before.modelId !== next.modelId ||
      before.dtype !== next.dtype ||
      before.device !== next.device
    )
      disposeOcrEngine();
    resetVendorTools();
    return next;
  });

  ipcMain.handle(
    "ocr:install",
    async (_e, modelId: string, dtype: OcrDtype) => {
      const r = await installOcrModel(modelId, dtype, (p) =>
        broadcast("ocr:installProgress", p),
      );
      if (r.ok) resetVendorTools();
      return r;
    },
  );

  ipcMain.handle("ocr:cancelInstall", (_e, modelId: string, dtype: OcrDtype) =>
    cancelOcrInstall(modelId, dtype),
  );

  ipcMain.handle("ocr:remove", async (_e, modelId: string) => {
    disposeOcrEngine();
    const r = await removeOcrModel(modelId);
    resetVendorTools();
    return r;
  });

  ipcMain.handle("ocr:pickFile", async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: "Read a document",
      properties: ["openFile"],
      filters: [
        {
          name: "Documents and pictures",
          extensions: ["pdf", "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"],
        },
      ],
    });
    return r.filePaths[0] ?? null;
  });

  // "Try it on a file" — the only way to know a model works on this machine
  // is to run it here, which is also the only honest way to show the speed.
  ipcMain.handle("ocr:test", async (_e, path: string) => {
    if (!ocrModel(getOcrConfig().modelId))
      return { ok: false, error: "No OCR model selected." };
    if (!canScan(path))
      return { ok: false, error: "Give it a PDF or an image." };
    const r = await scanDocument(path, { pages: [1] });
    if (r.error) return { ok: false, error: r.error };
    return {
      ok: true,
      text: r.markdown,
      seconds: Math.round(r.seconds * 10) / 10,
      device: r.device,
    };
  });
}
