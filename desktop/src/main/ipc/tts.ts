/**
 * TTS IPC — the on-device voice (Supertonic 3 in a child process).
 *
 * `tts:speak` returns raw Float32 PCM as base64: the renderer owns playback
 * (AudioContext, pause, barge-in), main owns synthesis. Streaming sentences
 * is the renderer's job — it calls speak once per sentence and queues the
 * results, so one slow sentence never stalls the one already audible.
 */

import { ipcMain, BrowserWindow, dialog } from "electron";
import {
  cancelTtsInstall,
  installTts,
  installVoice,
  removeTts,
  forgetVoiceStyle,
  speak,
  ttsNativeAvailable,
  ttsStatus,
  type SpeakResult,
  type TtsProgress,
  type TtsStatus,
} from "../tts/engine.js";
import { importCustomVoice, removeCustomVoice } from "../tts/custom-voices.js";
import { mixCustomVoice, previewMix, type MixPart } from "../tts/voice-mix.js";
import { fitVoice } from "../tts/voice-fit.js";
import {
  cancelSpeakerInstall,
  installSpeakerModel,
  speakerAvailable,
  speakerModelInstalled,
  SPEAKER_BYTES,
} from "../tts/speaker.js";
import { stripTtsTags, textForSpeech, TTS_TAGS } from "../tts/catalog.js";
import { markdownForSpeech } from "@shared/voice-tags.js";

export function registerTtsIPC(): void {
  ipcMain.handle("tts:available", (): boolean => ttsNativeAvailable());
  ipcMain.handle("tts:status", (): Promise<TtsStatus> => ttsStatus());
  ipcMain.handle(
    "tts:install",
    (e, firstVoice: string): Promise<{ ok: boolean; error?: string }> => {
      const send = (p: TtsProgress): void => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win && !win.isDestroyed()) win.webContents.send("tts:progress", p);
      };
      return installTts(firstVoice || "F1", send);
    },
  );
  ipcMain.handle("tts:cancelInstall", (): boolean => cancelTtsInstall());
  ipcMain.handle("tts:remove", () => removeTts());
  ipcMain.handle(
    "tts:installVoice",
    (_e, id: string): Promise<{ ok: boolean; error?: string }> => installVoice(id),
  );
  // A voice of your own: pick the JSON from Supertone's voice builder. The
  // dialog lives here rather than in the renderer because main owns the file
  // system and the validation.
  ipcMain.handle(
    "tts:importVoice",
    async (
      e,
      p: { name: string; gender: "F" | "M" },
    ): Promise<{ ok: boolean; id?: string; error?: string }> => {
      const win =
        BrowserWindow.fromWebContents(e.sender) ??
        BrowserWindow.getFocusedWindow();
      if (!win) return { ok: false };
      const picked = await dialog.showOpenDialog(win, {
        title: "Import a Supertonic 3 voice",
        filters: [{ name: "Voice style", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false };
      const r = importCustomVoice({ ...p, path: picked.filePaths[0] });
      if (r.ok && r.id) forgetVoiceStyle(r.id);
      return r;
    },
  );
  // Blending: the free route to a voice of your own, since Supertone's builder
  // charges per voice and currently sells none. Pure arithmetic on the styles.
  ipcMain.handle(
    "tts:mixVoice",
    (
      _e,
      p: { parts: MixPart[]; name: string; gender: "F" | "M" },
    ): { ok: boolean; id?: string; error?: string } => {
      const r = mixCustomVoice(p);
      if (r.ok && r.id) forgetVoiceStyle(r.id);
      return r;
    },
  );
  ipcMain.handle(
    "tts:previewMix",
    (
      _e,
      p: { parts: MixPart[]; gender: "F" | "M" },
    ): { ok: boolean; id?: string; error?: string } => {
      const r = previewMix(p);
      // The preview file is overwritten in place, so the child's style cache
      // would keep speaking the PREVIOUS blend — every slider move would
      // sound the same as the first one.
      if (r.ok && r.id) forgetVoiceStyle(r.id);
      return r;
    },
  );
  // ── A voice from your own recording ──────────────────────────────────
  ipcMain.handle("tts:matcherStatus", async () => ({
    installed: await speakerModelInstalled(),
    bytes: SPEAKER_BYTES,
    available: speakerAvailable(),
  }));
  ipcMain.handle("tts:installMatcher", (e) => {
    const send = (p: unknown): void => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (win && !win.isDestroyed()) win.webContents.send("tts:matcherProgress", p);
    };
    return installSpeakerModel(send);
  });
  ipcMain.handle("tts:cancelMatcher", (): boolean => cancelSpeakerInstall());

  let fitting = false;
  let cancelFit = false;
  ipcMain.handle(
    "tts:fitVoice",
    async (
      e,
      p: { samplesBase64: string; sampleRate: number; lang?: string },
    ): Promise<{
      ok: boolean;
      parts?: MixPart[];
      score?: number;
      baseScore?: number;
      error?: string;
    }> => {
      if (fitting) return { ok: false, error: "Already searching." };
      fitting = true;
      cancelFit = false;
      try {
        const buf = Buffer.from(p.samplesBase64, "base64");
        const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
        return await fitVoice({
          samples,
          sampleRate: p.sampleRate,
          lang: p.lang,
          cancelled: () => cancelFit,
          onProgress: (prog) => {
            const win = BrowserWindow.fromWebContents(e.sender);
            if (win && !win.isDestroyed()) win.webContents.send("tts:fitProgress", prog);
          },
        });
      } finally {
        fitting = false;
      }
    },
  );
  ipcMain.handle("tts:cancelFit", (): boolean => {
    if (!fitting) return false;
    cancelFit = true;
    return true;
  });

  ipcMain.handle("tts:removeVoice", (_e, id: string): { ok: boolean } => {
    const r = removeCustomVoice(id);
    if (r.ok) forgetVoiceStyle(id);
    return r;
  });
  ipcMain.handle(
    "tts:speak",
    (
      _e,
      p: { text: string; voice: string; lang?: string; steps?: number; speed?: number },
    ): Promise<SpeakResult> =>
      speak({ ...p, text: markdownForSpeech(textForSpeech(p.text)) }),
  );
  // Pure helpers the renderer needs for display; shipped over IPC rather than
  // duplicated so the tag list has exactly one home.
  ipcMain.handle("tts:stripTags", (_e, text: string): string => stripTtsTags(text));
  ipcMain.handle("tts:tags", (): string[] => [...TTS_TAGS]);
}
