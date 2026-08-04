/**
 * TTS IPC — the on-device voice (Supertonic 3 in a child process).
 *
 * `tts:speak` returns raw Float32 PCM as base64: the renderer owns playback
 * (AudioContext, pause, barge-in), main owns synthesis. Streaming sentences
 * is the renderer's job — it calls speak once per sentence and queues the
 * results, so one slow sentence never stalls the one already audible.
 */

import { ipcMain, BrowserWindow } from "electron";
import {
  cancelTtsInstall,
  installTts,
  installVoice,
  removeTts,
  speak,
  ttsNativeAvailable,
  ttsStatus,
  type SpeakResult,
  type TtsProgress,
  type TtsStatus,
} from "../tts/engine.js";
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
