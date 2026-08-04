/**
 * STT IPC handler — speech-to-text via an OpenAI-compatible transcription
 * endpoint (OpenAI Whisper, Groq, a local faster-whisper server, LM Studio…).
 *
 * The renderer records audio with MediaRecorder and sends the bytes here;
 * the POST happens in the main process so CORS never gets in the way.
 * (Chromium's built-in SpeechRecognition doesn't work in Electron — it needs
 * Google's speech backend, which is exactly the network error the mic button
 * used to produce.)
 */

import { ipcMain, BrowserWindow } from "electron";
import {
  getSttSettings,
  setSttSettings,
  type SttSettings,
} from "../stt-settings.js";
import {
  cancelInstall,
  installModel,
  listSttModels,
  removeModel,
  sttNativeAvailable,
  transcribePcm,
  type InstallProgress,
  type SttModelStatus,
} from "../stt/gigaam.js";

interface SttPayload {
  audioBase64: string;
  mimeType: string;
  /** Full URL, e.g. https://api.groq.com/openai/v1/audio/transcriptions */
  endpoint: string;
  apiKey?: string;
  /** e.g. whisper-large-v3 (Groq), whisper-1 (OpenAI) */
  model?: string;
  /** Optional ISO language hint, e.g. "ru". */
  language?: string;
}

interface SttResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export function registerSttIPC(): void {
  // Settings live in the data dir, not the renderer: localStorage is keyed by
  // origin, and the dev server's port moves when it is taken — which read as
  // "my API key resets every time".
  ipcMain.handle("stt:getSettings", (): SttSettings => getSttSettings());
  ipcMain.handle(
    "stt:setSettings",
    (_e, patch: Partial<SttSettings>): SttSettings => setSttSettings(patch),
  );

  // ── On-device GigaAM (sherpa-onnx) ────────────────────────────────────
  // Whisper-in-the-renderer stays where it is; this is the second local
  // engine, and it is the one that knows Russian.
  ipcMain.handle("stt:nativeAvailable", (): boolean => sttNativeAvailable());
  ipcMain.handle("stt:models", (): Promise<SttModelStatus[]> => listSttModels());
  ipcMain.handle(
    "stt:installModel",
    async (e, id: string): Promise<{ ok: boolean; error?: string }> => {
      const send = (p: InstallProgress): void => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win && !win.isDestroyed()) win.webContents.send("stt:modelProgress", p);
      };
      return installModel(id, send);
    },
  );
  ipcMain.handle("stt:cancelInstall", (_e, id: string): boolean =>
    cancelInstall(id),
  );
  ipcMain.handle("stt:removeModel", (_e, id: string) => removeModel(id));
  ipcMain.handle(
    "stt:transcribePcm",
    (
      _e,
      p: { modelId: string; samples: Float32Array; sampleRate: number },
    ) => transcribePcm(p.modelId, p.samples, p.sampleRate ?? 16000),
  );

  ipcMain.handle(
    "stt:transcribe",
    async (_e, p: SttPayload): Promise<SttResult> => {
      try {
        if (!p?.endpoint) {
          return { ok: false, error: "No transcription endpoint configured" };
        }
        const buf = Buffer.from(p.audioBase64, "base64");
        const ext = p.mimeType.includes("ogg")
          ? "ogg"
          : p.mimeType.includes("wav")
            ? "wav"
            : p.mimeType.includes("mp4")
              ? "m4a"
              : "webm";

        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(buf)], { type: p.mimeType }),
          `audio.${ext}`,
        );
        form.append("model", p.model || "whisper-1");
        if (p.language) form.append("language", p.language);

        const res = await fetch(p.endpoint, {
          method: "POST",
          headers: p.apiKey
            ? { Authorization: `Bearer ${p.apiKey}` }
            : undefined,
          body: form,
        });

        if (!res.ok) {
          const t = await res.text();
          return { ok: false, error: `STT ${res.status}: ${t.slice(0, 300)}` };
        }
        const data = (await res.json()) as { text?: string };
        return { ok: true, text: (data.text ?? "").trim() };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Transcription failed",
        };
      }
    },
  );
}
