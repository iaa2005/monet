/**
 * Mic button with a device dropdown and live level meter.
 *
 * Chromium's SpeechRecognition doesn't work in Electron (it needs Google's
 * speech backend), so dictation records audio with MediaRecorder using the
 * selected input device and transcribes it through an OpenAI-compatible
 * endpoint (OpenAI Whisper, Groq, local faster-whisper, LM Studio…) — the
 * POST happens in the main process (stt:transcribe), so no CORS.
 *
 * Dictation is PSEUDO-STREAMING. The models here are batch models (GigaAM
 * and Whisper take a whole clip and return a whole text — no partial
 * hypotheses), so true live captions are off the table; what is not off the
 * table is cutting the recording at speech pauses. A small VAD watches the
 * input level while you talk; each ~pause ends the current segment, the
 * recorder restarts on the same stream (the VoiceMode trick), and the
 * finished segment goes into a SEQUENTIAL transcription queue whose results
 * append to the composer in order. You keep dictating — and typing — while
 * earlier fragments are still being recognised.
 *
 * UI: the mic toggles recording; a small chevron appears on hover and opens
 * a panel with the input-device list, a live input-level bar, and the
 * transcription settings (endpoint / API key / model).
 *
 * Those settings live in MAIN's data dir (stt.json, key encrypted with
 * safeStorage), not in localStorage. localStorage is keyed by origin, and the
 * dev renderer's origin carries the vite port — which moves when the port is
 * taken, so the whole panel came up blank and read as "my API key resets
 * every launch". The old localStorage values are migrated once, then dropped.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2, Mic, Settings2, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";
// Vite-native worker import — more dependable than `new Worker(new URL(...))`
// in electron-vite dev mode (a worker that fails to LOAD dies silently).
import SttWorker from "../../workers/stt-worker?worker";
import { useChatStore } from "@/stores/chatStore";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** Legacy localStorage keys — read once at startup, then removed. */
const LEGACY_KEYS = {
  deviceId: "mic-device-id",
  engine: "stt-engine",
  endpoint: "stt-endpoint",
  key: "stt-key",
  model: "stt-model",
  localModel: "stt-local-model",
  language: "stt-language",
} as const;

const LOCAL_MODELS = [
  { id: "Xenova/whisper-tiny", label: "Fast (~147 MB)" },
  { id: "Xenova/whisper-base", label: "Balanced (~280 MB)" },
  { id: "Xenova/whisper-small", label: "Accurate (~926 MB)" },
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

function getSttWorker(model: string): Worker {
  if (!sttWorker) {
    sttWorker = new SttWorker();
    sttWorker.addEventListener("error", (e: ErrorEvent) => {
      console.error(
        `[stt] worker error: ${e.message} (${e.filename}:${e.lineno})`,
      );
    });
    sttWorker.addEventListener("messageerror", (e) => {
      console.error("[stt] worker messageerror:", e);
    });
  }
  return sttWorker;
}

function releaseSttWorker(reason: string): void {
  if (!sttWorker) return;
  console.log(`[stt] terminating worker: ${reason}`);
  sttWorker.terminate();
  sttWorker = null;
  sttSeq = 0;
}

let lastModel: string | null = null;

function transcribeLocal(
  audio: Float32Array,
  model: string,
  language: string,
  onStatus: (text: string) => void,
): Promise<string> {
  // If the model changed, kill the old worker — WASM memory isn't freed by GC.
  if (lastModel && lastModel !== model) {
    releaseSttWorker(`model switch ${lastModel} → ${model}`);
  }
  lastModel = model;
  const worker = getSttWorker(model);
  const id = ++sttSeq;
  return new Promise((resolve, reject) => {
    // Watchdog: if inference wedges (bad backend, driver issue), fail loudly
    // instead of leaving the mic spinner stuck forever.
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onWorkerError);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Local transcription timed out — try the Fast model or the cloud engine.",
        ),
      );
    }, 120_000);
    const onWorkerError = (e: ErrorEvent): void => {
      cleanup();
      reject(
        new Error(
          `Voice engine failed to load: ${e.message || "worker error"}`,
        ),
      );
    };
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
        cleanup();
        resolve(msg.text);
      } else if (msg.type === "error") {
        cleanup();
        reject(new Error(msg.error));
      }
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onWorkerError);
    console.log(
      `[stt] postMessage #${id}: ${audio.length} samples, model=${model}`,
    );
    worker.postMessage({ id, audio, model, language: language || undefined });
    console.log(`[stt] postMessage #${id} sent`);
  });
}

interface MicButtonProps {
  /** Called with the transcribed text. */
  onText: (text: string) => void;
  /** Non-fatal problems (device/transcription errors).
   *  @deprecated Errors are now displayed inline near the mic button. */
  onError?: (message: string) => void;
}

export function MicButton({ onText }: MicButtonProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [engine, setEngine] = useState<string>("local");
  const [endpoint, setEndpoint] = useState<string>("");
  const [sttKey, setSttKey] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [localModel, setLocalModel] = useState<string>("Xenova/whisper-base");
  const [nativeModel, setNativeModel] = useState<string>("gigaam-v3-rnnt-punct");
  const [language, setLanguage] = useState<string>("");

  // Load from main, migrating anything the old localStorage build left behind.
  useEffect(() => {
    let gone = false;
    void (async () => {
      const legacy: Record<string, string> = {};
      for (const [field, lsKey] of Object.entries(LEGACY_KEYS)) {
        const v = localStorage.getItem(lsKey);
        if (v) legacy[field] = v;
      }
      let saved = await api()?.stt.getSettings();
      if (saved && Object.keys(legacy).length > 0) {
        // Only fill blanks: whatever is already in the data dir wins, so a
        // second window cannot resurrect stale values over newer ones.
        const patch = Object.fromEntries(
          Object.entries(legacy).filter(
            ([k]) => !(saved as Record<string, unknown>)[k],
          ),
        );
        if (Object.keys(patch).length > 0)
          saved = await api()?.stt.setSettings(patch);
        for (const lsKey of Object.values(LEGACY_KEYS))
          localStorage.removeItem(lsKey);
      }
      if (gone || !saved) return;
      setDeviceId(saved.deviceId);
      setEngine(saved.engine);
      setEndpoint(saved.endpoint);
      setSttKey(saved.key);
      setModel(saved.model);
      setLocalModel(saved.localModel);
      setNativeModel(saved.nativeModel);
      setLanguage(saved.language);
    })();
    return () => {
      gone = true;
    };
  }, []);
  const [status, setStatus] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const errTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  function showError(msg: string): void {
    setErrMsg(msg);
    clearTimeout(errTimerRef.current);
    errTimerRef.current = setTimeout(() => setErrMsg(null), 6000);
  }

  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Where the panel sits on screen. It is portalled to <body> and positioned
   * by hand: inside the composer it was clipped by the first ancestor with
   * `overflow: hidden` — the right half of it simply disappeared. */
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(
    null,
  );
  const barRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);
  // Live values for callbacks bound once.
  const recordingRef = useRef(false);
  recordingRef.current = recording;

  // ── Pseudo-streaming state ─────────────────────────────────────────────
  // The VAD's own analyser (the meter's context opens and closes with the
  // panel; the VAD must live exactly as long as the recording does).
  const vadCtxRef = useRef<AudioContext | null>(null);
  const vadRafRef = useRef(0);
  /** The user pressed stop: the segment now ending is the last one. */
  const finalRef = useRef(false);
  /** Speech was heard in the CURRENT segment (a segment with none is noise). */
  const heardRef = useRef(false);
  const lastLoudRef = useRef(0);
  const segBornRef = useRef(0);
  /** Sequential transcription: each segment appends behind the previous
   * one, so fragments land in the composer in spoken order even when a
   * later (shorter) segment finishes recognition first. */
  const queueTailRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(0);
  /** Characters this dictation has produced — the "was it all silence?"
   * check moves to the END of the whole dictation, so per-segment misses
   * stay silent instead of stacking warning pills mid-sentence. */
  const emittedRef = useRef(0);
  const [pending, setPending] = useState(0);

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
    void api()?.stt.setSettings({ deviceId: id });
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

  // ── Recording (pseudo-streaming: one recorder per pause-cut segment) ───

  /** The pause that ends a segment, and the least a segment may be. Cutting
   * mid-word garbles both halves, so the cut waits for real quiet; cutting
   * on every breath would flood the queue with half-second clips. */
  const PAUSE_MS = 700;
  const MIN_SEGMENT_MS = 1400;
  const SPEECH_RMS = 0.02;

  /** One recorder = one segment. On a pause cut the next recorder starts on
   * the SAME stream, so nothing is torn down mid-dictation — the same trick
   * VoiceMode uses for its echo windows. */
  function startSegmentRecorder(stream: MediaStream): void {
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      const final = finalRef.current;
      const blob = new Blob(chunks, { type: rec.mimeType });
      enqueueSegment(blob, final);
      if (!final && recordingRef.current && streamRef.current) {
        startSegmentRecorder(streamRef.current);
      } else if (final) {
        if (!menuOpen) releaseStream();
        else if (streamRef.current) startMeter(streamRef.current);
      }
    };
    recorderRef.current = rec;
    heardRef.current = false;
    segBornRef.current = Date.now();
    lastLoudRef.current = Date.now();
    rec.start();
  }

  /** Watch the input level; a long-enough quiet after speech cuts the
   * segment so it can be transcribed while the user keeps talking. */
  function startVad(stream: MediaStream): void {
    stopVad();
    const ctx = new AudioContext();
    vadCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const tick = (): void => {
      if (!recordingRef.current) return;
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      const rms = Math.sqrt(sum / data.length);
      const now = Date.now();
      if (rms > SPEECH_RMS) {
        heardRef.current = true;
        lastLoudRef.current = now;
      }
      if (
        heardRef.current &&
        now - lastLoudRef.current >= PAUSE_MS &&
        now - segBornRef.current >= MIN_SEGMENT_MS
      ) {
        // Cut: the recorder's onstop enqueues this segment and starts the
        // next one; the born/heard state resets there. The state check keeps
        // the loop from stopping an already-stopping recorder in the frames
        // between stop() and its async onstop.
        const rec = recorderRef.current;
        if (rec && rec.state === "recording") rec.stop();
      }
      vadRafRef.current = requestAnimationFrame(tick);
    };
    vadRafRef.current = requestAnimationFrame(tick);
  }

  function stopVad(): void {
    cancelAnimationFrame(vadRafRef.current);
    vadCtxRef.current?.close().catch(() => {});
    vadCtxRef.current = null;
  }

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
      finalRef.current = false;
      emittedRef.current = 0;
      setRecording(true);
      recordingRef.current = true; // the VAD loop reads it before re-render
      startSegmentRecorder(stream);
      startVad(stream);
    } catch {
      showError("Couldn't start recording — check microphone permissions.");
    }
  }

  function stopRecording(): void {
    finalRef.current = true;
    setRecording(false);
    recordingRef.current = false;
    stopVad();
    // Mid-cut (recorder already stopping) the flag alone is enough: its
    // onstop sees final=true, flushes, and does not respawn.
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") rec.stop();
    recorderRef.current = null;
  }

  /** Put a segment behind everything already recognising. The chain is the
   * ordering guarantee; the pending counter is what the UI shows. */
  function enqueueSegment(blob: Blob, final: boolean): void {
    pendingRef.current += 1;
    setPending(pendingRef.current);
    if (pendingRef.current > 0) setStatus("Transcribing…");
    queueTailRef.current = queueTailRef.current
      .then(() => transcribeSegment(blob))
      .catch(() => {})
      .finally(() => {
        pendingRef.current -= 1;
        setPending(pendingRef.current);
        if (pendingRef.current === 0) {
          setStatus(null);
          // The whole dictation is done and NOTHING came out — say so once,
          // here, instead of one pill per too-quiet segment mid-sentence.
          if (final && emittedRef.current === 0)
            showError(
              "No speech recognized — try again, a bit longer and closer to the mic.",
            );
        }
      });
  }

  async function transcribeSegment(blob: Blob): Promise<void> {
    if (blob.size < 1000) return; // an accidental click, not speech
    try {
      if (engine === "local") {
        // Free on-device Whisper. First run downloads the model (progress in
        // the panel), later runs are offline.
        const pcm = await blobToPCM16k(blob);
        // Peak level check: silence in → garbage/nothing out. Skip quietly —
        // a pause-cut segment with no speech is normal, not an error.
        let peak = 0;
        for (let i = 0; i < pcm.length; i += 50) {
          const v = Math.abs(pcm[i]);
          if (v > peak) peak = v;
        }
        const dur = pcm.length / 16000;
        console.log(
          `[stt] segment ${dur.toFixed(1)}s, peak=${peak.toFixed(3)}, blob=${blob.size}B ${blob.type}`,
        );
        if (dur < 0.8 || peak < 0.01) return;
        const text = await transcribeLocal(pcm, localModel, language, setStatus);
        console.log(`[stt] result: ${JSON.stringify(text)}`);
        if (text) {
          emittedRef.current += text.length;
          onText(text);
        }
      } else if (engine === "ondevice") {
        // GigaAM in main: the audio never leaves the machine, and the model
        // writes its own punctuation.
        const pcm = await blobToPCM16k(blob);
        if (pcm.length / 16000 < 0.5) return;
        // A copy: the buffer is transferred to main's worker, and the one the
        // AudioContext handed us is not ours to give away.
        const samples = new Float32Array(pcm);
        const res = await api()?.stt.transcribePcm({
          modelId: nativeModel,
          samples,
          sampleRate: 16000,
        });
        console.log(`[stt] gigaam: ${res?.ms}ms, ok=${res?.ok}`);
        if (res?.ok && res.text) {
          emittedRef.current += res.text.length;
          onText(res.text);
        } else if (!res?.ok) showError(res?.error || "Transcription failed");
      } else {
        const audioBase64 = await blobToBase64(blob);
        const res = await api()?.stt.transcribe({
          audioBase64,
          mimeType: blob.type || "audio/webm",
          endpoint: endpoint.trim(),
          apiKey: sttKey.trim() || undefined,
          model: model.trim() || undefined,
        });
        if (res?.ok && res.text) {
          emittedRef.current += res.text.length;
          onText(res.text);
        } else if (res && !res.ok)
          showError(res.error || "Transcription failed");
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : "Transcription failed");
    }
  }

  // ── Housekeeping ───────────────────────────────────────────────────────
  const PANEL_WIDTH = 320; // w-80
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const place = (): void => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      // Left-aligned with the button, pulled back when that would run off the
      // right edge of the window.
      const left = Math.max(
        8,
        Math.min(r.left, window.innerWidth - PANEL_WIDTH - 8),
      );
      setAnchor({ left, bottom: window.innerHeight - r.top + 6 });
    };
    place();
    window.addEventListener("resize", place);
    // Capture: the composer scrolls inside its own container, not the window.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    // Close on outside click.
    if (!menuOpen) return;
    const handler = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      // The model and language lists are Radix popups: they render in a portal
      // at the end of <body>, so by the DOM they are ALWAYS outside this
      // panel. Without this, picking a Whisper model closed the whole thing.
      if (target?.closest?.("[data-radix-popper-content-wrapper]")) return;
      // The panel itself lives in a portal, so "inside the button" is not the
      // whole test any more.
      if (panelRef.current?.contains(target as Node)) return;
      if (rootRef.current && !rootRef.current.contains(target as Node)) {
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
      finalRef.current = true; // the last segment must not respawn a recorder
      stopVad();
      recorderRef.current?.stop();
      releaseStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Optimistic in the UI, durable in main. */
  const saveSetting = (
    // Every settings field, not just the ones the localStorage build had —
    // `nativeModel` postdates that migration and has no legacy key.
    field: keyof typeof LEGACY_KEYS | "nativeModel",
    value: string,
    set: (v: string) => void,
  ): void => {
    set(value);
    void api()?.stt.setSettings({ [field]: value });
  };

  // Derived: segments still recognising. While RECORDING the red square must
  // win over the spinner — transcription runs behind the live mic by design.
  const busy = pending > 0;
  const draining = busy && !recording;
  return (
    <div ref={rootRef} className="group/mic relative flex items-center">
      <button
        type="button"
        title={
          recording
            ? "Stop dictation"
            : draining
              ? "Transcribing…"
              : "Dictate (voice input)"
        }
        onClick={() => (recording ? stopRecording() : void startRecording())}
        disabled={draining}
        className={cn(
          "flex size-7 items-center justify-center rounded-md transition-colors",
          recording
            ? "animate-pulse bg-destructive/15 text-destructive"
            : "text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]",
          draining && "opacity-60",
        )}
      >
        {recording ? (
          <Square className="size-3.5 fill-current" />
        ) : draining ? (
          <Loader2 className="size-4 animate-spin" />
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

      {/* STT warning pill (auto-dismissed after 6s) — amber, not red;
          these are recoverable, not chat-critical errors. */}
      {errMsg && (
        <div className="absolute bottom-full left-0 z-40 mb-1.5 flex items-center gap-1.5 whitespace-nowrap rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[12px] text-amber-600 shadow-sm dark:text-amber-400">
          {errMsg}
        </div>
      )}

      {menuOpen &&
        anchor &&
        createPortal(
        // Two columns: with four downloadable models the single column grew
        // taller than the window and the top of it went off-screen.
        <div
          ref={panelRef}
          style={{ left: anchor.left, bottom: anchor.bottom }}
          className="fixed z-[100] flex w-80 flex-col rounded-lg border border-border bg-card p-2 shadow-lg"
        >
          <div className="max-h-[70vh] overflow-y-auto overflow-x-hidden">
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
                  className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                >
                  <span className="flex w-4 shrink-0 justify-center pt-0.5">
                    {selected && <Check className="size-3.5 text-link" />}
                  </span>
                  <span className="min-w-0 leading-snug break-words">
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
                className="h-full w-0 rounded-full bg-green-text transition-[width] duration-75"
              />
            </div>
          </div>


          <div className="-mx-1 my-1.5 h-px bg-border" />
          <button
            type="button"
            onClick={() => {
              closeMenu();
              useChatStore.getState().requestOpenSettings("voice");
            }}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
          >
            <Settings2 className="size-3.5" />
            Voice settings — engines, models, voices
          </button>
          </div>

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
        </div>,
          document.body,
        )}
    </div>
  );
}
