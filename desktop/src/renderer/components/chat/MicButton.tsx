/**
 * Mic button with a device dropdown and live level meter.
 *
 * Chromium's SpeechRecognition doesn't work in Electron (it needs Google's
 * speech backend), so dictation records audio with MediaRecorder using the
 * selected input device and transcribes it through an OpenAI-compatible
 * endpoint (OpenAI Whisper, Groq, local faster-whisper, LM Studio…) — the
 * POST happens in the main process (stt:transcribe), so no CORS.
 *
 * UI: the mic toggles recording; a small chevron appears on hover and opens
 * a panel with the input-device list, a live input-level bar, and the
 * transcription settings (endpoint / API key / model), persisted in
 * localStorage.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Mic, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const LS_DEVICE = "mic-device-id";
const LS_ENGINE = "stt-engine"; // "local" | "cloud"
const LS_ENDPOINT = "stt-endpoint";
const LS_KEY = "stt-key";
const LS_MODEL = "stt-model";
const LS_LOCAL_MODEL = "stt-local-model";
const LS_LANGUAGE = "stt-language"; // "" (auto) | "ru" | "en"

const LOCAL_MODELS = [
  { id: "Xenova/whisper-tiny", label: "Fast (~40 MB)" },
  { id: "Xenova/whisper-base", label: "Balanced (~80 MB)" },
  { id: "Xenova/whisper-small", label: "Accurate (~250 MB)" },
];

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Decode a recorded blob to 16 kHz mono PCM — what Whisper expects. Chromium
 * resamples inside decodeAudioData when the context is created at 16 kHz. */
async function blobToPCM16k(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const audio = await ctx.decodeAudioData(buf);
    return audio.getChannelData(0);
  } finally {
    void ctx.close().catch(() => {});
  }
}

// ── Local Whisper worker (shared across MicButton instances) ─────────────
type WorkerMsg =
  | {
      id: number;
      type: "progress";
      /** Overall percentage aggregated across all model files. */
      progress: number;
      /** Bytes downloaded / total, summed over the files seen so far. */
      loaded: number;
      total: number;
    }
  | { id: number; type: "status"; text: string }
  | { id: number; type: "result"; text: string }
  | { id: number; type: "error"; error: string };

let sttWorker: Worker | null = null;
let sttSeq = 0;

function getSttWorker(): Worker {
  if (!sttWorker) {
    sttWorker = new Worker(
      new URL("../../workers/stt-worker.ts", import.meta.url),
      { type: "module" },
    );
  }
  return sttWorker;
}

function transcribeLocal(
  audio: Float32Array,
  model: string,
  language: string,
  onStatus: (text: string) => void,
): Promise<string> {
  const worker = getSttWorker();
  const id = ++sttSeq;
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent<WorkerMsg>): void => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.type === "progress") {
        const mb = (n: number): string => (n / 1048576).toFixed(0);
        onStatus(
          `Downloading model… ${msg.progress}% (${mb(msg.loaded)} / ${mb(msg.total)} MB)`,
        );
      } else if (msg.type === "status") {
        onStatus(msg.text);
      } else if (msg.type === "result") {
        worker.removeEventListener("message", onMessage);
        resolve(msg.text);
      } else if (msg.type === "error") {
        worker.removeEventListener("message", onMessage);
        reject(new Error(msg.error));
      }
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, audio, model, language: language || undefined });
  });
}

interface MicButtonProps {
  /** Called with the transcribed text. */
  onText: (text: string) => void;
  /** Non-fatal problems (device/transcription errors). */
  onError: (message: string) => void;
}

export function MicButton({ onText, onError }: MicButtonProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(
    () => localStorage.getItem(LS_DEVICE) ?? "",
  );
  const [engine, setEngine] = useState<string>(
    () => localStorage.getItem(LS_ENGINE) ?? "local",
  );
  const [endpoint, setEndpoint] = useState<string>(
    () => localStorage.getItem(LS_ENDPOINT) ?? "",
  );
  const [sttKey, setSttKey] = useState<string>(
    () => localStorage.getItem(LS_KEY) ?? "",
  );
  const [model, setModel] = useState<string>(
    () => localStorage.getItem(LS_MODEL) ?? "",
  );
  const [localModel, setLocalModel] = useState<string>(
    () => localStorage.getItem(LS_LOCAL_MODEL) ?? "Xenova/whisper-base",
  );
  const [language, setLanguage] = useState<string>(
    () => localStorage.getItem(LS_LANGUAGE) ?? "",
  );
  const [status, setStatus] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);
  // Live values for callbacks bound once.
  const recordingRef = useRef(false);
  recordingRef.current = recording;

  // ── Meter ──────────────────────────────────────────────────────────────
  function stopMeter(): void {
    cancelAnimationFrame(rafRef.current);
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    if (barRef.current) barRef.current.style.width = "0%";
  }

  function startMeter(stream: MediaStream): void {
    stopMeter();
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = (): void => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      const pct = Math.min(100, Math.round((peak / 128) * 140));
      // Write straight to the DOM — no React state per animation frame.
      if (barRef.current) barRef.current.style.width = `${pct}%`;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  function releaseStream(): void {
    stopMeter();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function acquireStream(id: string): Promise<MediaStream> {
    const constraints: MediaStreamConstraints = {
      audio: id ? { deviceId: { exact: id } } : true,
    };
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
      // The remembered device may be unplugged — fall back to the default.
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }

  // ── Device list / preview (while the menu is open) ─────────────────────
  async function openMenu(): Promise<void> {
    setMenuOpen(true);
    setHint(null);
    try {
      if (!recordingRef.current) {
        const stream = await acquireStream(deviceId);
        streamRef.current = stream;
        startMeter(stream);
      }
      // Labels are only populated once permission has been granted.
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list.filter((d) => d.kind === "audioinput"));
    } catch {
      setHint("Microphone access was denied.");
    }
  }

  function closeMenu(): void {
    setMenuOpen(false);
    if (!recordingRef.current) releaseStream();
  }

  async function selectDevice(id: string): Promise<void> {
    setDeviceId(id);
    localStorage.setItem(LS_DEVICE, id);
    if (recordingRef.current) return; // applies to the next recording
    releaseStream();
    try {
      const stream = await acquireStream(id);
      streamRef.current = stream;
      startMeter(stream);
    } catch {
      setHint("Couldn't open that microphone.");
    }
  }

  // ── Recording ──────────────────────────────────────────────────────────
  async function startRecording(): Promise<void> {
    if (engine === "cloud" && !endpoint.trim()) {
      // Nothing to transcribe with — open the settings instead of failing.
      void openMenu();
      setHint(
        "Set a transcription endpoint first (OpenAI-compatible /audio/transcriptions), or switch to the free local engine.",
      );
      return;
    }
    try {
      const stream = streamRef.current ?? (await acquireStream(deviceId));
      streamRef.current = stream;
      startMeter(stream);
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "";
      const rec = new MediaRecorder(
        stream,
        mime ? { mimeType: mime } : undefined,
      );
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        void transcribe(new Blob(chunks, { type: rec.mimeType }));
        if (!menuOpen) releaseStream();
        else if (streamRef.current) startMeter(streamRef.current);
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      onError("Couldn't start recording — check microphone permissions.");
    }
  }

  function stopRecording(): void {
    setRecording(false);
    recorderRef.current?.stop();
    recorderRef.current = null;
  }

  async function transcribe(blob: Blob): Promise<void> {
    if (blob.size < 1000) return; // an accidental click, not speech
    setBusy(true);
    try {
      if (engine === "local") {
        // Free on-device Whisper. First run downloads the model (progress in
        // the panel), later runs are offline.
        setStatus("Preparing audio…");
        const pcm = await blobToPCM16k(blob);
        const text = await transcribeLocal(pcm, localModel, language, setStatus);
        if (text) onText(text);
      } else {
        setStatus("Transcribing…");
        const audioBase64 = await blobToBase64(blob);
        const res = await api()?.stt.transcribe({
          audioBase64,
          mimeType: blob.type || "audio/webm",
          endpoint: endpoint.trim(),
          apiKey: sttKey.trim() || undefined,
          model: model.trim() || undefined,
        });
        if (res?.ok && res.text) onText(res.text);
        else if (res && !res.ok) onError(res.error || "Transcription failed");
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Transcription failed");
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  // ── Housekeeping ───────────────────────────────────────────────────────
  useEffect(() => {
    // Close on outside click.
    if (!menuOpen) return;
    const handler = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);

  useEffect(() => {
    // Full cleanup on unmount.
    return () => {
      recorderRef.current?.stop();
      releaseStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSetting = (
    key: string,
    value: string,
    set: (v: string) => void,
  ): void => {
    set(value);
    localStorage.setItem(key, value);
  };

  return (
    <div ref={rootRef} className="group/mic relative flex items-center">
      <button
        type="button"
        title={
          recording
            ? "Stop dictation"
            : busy
              ? "Transcribing…"
              : "Dictate (voice input)"
        }
        onClick={() => (recording ? stopRecording() : void startRecording())}
        disabled={busy}
        className={cn(
          "flex size-7 items-center justify-center rounded-md transition-colors",
          recording
            ? "animate-pulse bg-destructive/15 text-destructive"
            : "text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]",
          busy && "opacity-60",
        )}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : recording ? (
          <Square className="size-3.5 fill-current" />
        ) : (
          <Mic className="size-4" />
        )}
      </button>

      {/* Chevron appears on hover next to the mic. */}
      <button
        type="button"
        title="Microphone settings"
        aria-label="Microphone settings"
        onClick={() => (menuOpen ? closeMenu() : void openMenu())}
        className={cn(
          "flex h-7 w-3.5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/mic:opacity-100",
          menuOpen && "opacity-100",
        )}
      >
        <ChevronDown className="size-3" />
      </button>

      {/* Progress pill when transcribing with the panel closed (e.g. the
          first-use model download would otherwise be invisible). */}
      {busy && !menuOpen && status && (
        <div className="absolute bottom-full left-0 z-40 mb-1.5 flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-[12px] text-muted-foreground shadow-sm">
          <Loader2 className="size-3 animate-spin" />
          {status}
        </div>
      )}

      {menuOpen && (
        <div className="absolute bottom-full left-0 z-50 mb-1.5 w-80 rounded-lg border border-border bg-card p-2 shadow-lg">
          <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Microphone
          </div>

          {devices.length === 0 ? (
            <div className="px-1 py-2 text-[13px] text-muted-foreground">
              No input devices found.
            </div>
          ) : (
            devices.map((d) => {
              const selected = deviceId
                ? d.deviceId === deviceId
                : d.deviceId === "default";
              return (
                <button
                  key={d.deviceId}
                  type="button"
                  onClick={() => void selectDevice(d.deviceId)}
                  className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                >
                  <span className="flex w-4 justify-center">
                    {selected && <Check className="size-3.5 text-link" />}
                  </span>
                  <span className="truncate">
                    {d.label || `Microphone ${d.deviceId.slice(0, 6)}`}
                  </span>
                </button>
              );
            })
          )}

          {/* Live input level. */}
          <div className="mx-1 my-2">
            <div className="mb-1 text-[11px] text-muted-foreground">
              Input level
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
              <div
                ref={barRef}
                className="h-full w-0 rounded-full bg-emerald-500 transition-[width] duration-75"
              />
            </div>
          </div>

          <div className="-mx-1 my-1.5 h-px bg-border" />

          <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Transcription
          </div>
          <div className="flex flex-col gap-1 px-1 pb-1">
            {(
              [
                ["local", "Local — free, on-device (Whisper)"],
                ["cloud", "Cloud — OpenAI-compatible API"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => saveSetting(LS_ENGINE, id, setEngine)}
                className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
              >
                <span className="flex w-4 justify-center">
                  {engine === id && <Check className="size-3.5 text-link" />}
                </span>
                {label}
              </button>
            ))}
          </div>

          {engine === "local" ? (
            <div className="flex flex-col gap-1.5 px-1 pb-1">
              <div className="flex gap-1.5">
                <select
                  value={localModel}
                  onChange={(e) =>
                    saveSetting(LS_LOCAL_MODEL, e.target.value, setLocalModel)
                  }
                  className="w-3/5 rounded-md border border-border bg-background px-1.5 py-1 text-[12px] outline-none focus:border-link"
                >
                  {LOCAL_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <select
                  value={language}
                  onChange={(e) =>
                    saveSetting(LS_LANGUAGE, e.target.value, setLanguage)
                  }
                  className="w-2/5 rounded-md border border-border bg-background px-1.5 py-1 text-[12px] outline-none focus:border-link"
                >
                  <option value="">Auto language</option>
                  <option value="ru">Русский</option>
                  <option value="en">English</option>
                </select>
              </div>
              <div className="text-[11px] leading-snug text-muted-foreground">
                The model downloads on first use and is cached — after that it
                works offline. No API key needed.
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 px-1 pb-1">
              <input
                value={endpoint}
                onChange={(e) =>
                  saveSetting(LS_ENDPOINT, e.target.value, setEndpoint)
                }
                placeholder="https://api.groq.com/openai/v1/audio/transcriptions"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground/60 focus:border-link"
              />
              <div className="flex gap-1.5">
                <input
                  value={sttKey}
                  onChange={(e) => saveSetting(LS_KEY, e.target.value, setSttKey)}
                  placeholder="API key"
                  type="password"
                  spellCheck={false}
                  className="w-1/2 rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground/60 focus:border-link"
                />
                <input
                  value={model}
                  onChange={(e) => saveSetting(LS_MODEL, e.target.value, setModel)}
                  placeholder="whisper-large-v3"
                  spellCheck={false}
                  className="w-1/2 rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground/60 focus:border-link"
                />
              </div>
            </div>
          )}

          {status && (
            <div className="mx-1 mb-1 flex items-center gap-1.5 rounded-md bg-black/[0.04] px-2 py-1 text-[12px] text-muted-foreground dark:bg-white/[0.06]">
              <Loader2 className="size-3 animate-spin" />
              {status}
            </div>
          )}

          {hint && (
            <div className="mx-1 mb-1 rounded-md bg-amber-500/10 px-2 py-1 text-[12px] text-amber-600 dark:text-amber-400">
              {hint}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
