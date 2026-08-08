/**
 * "Build a voice from your recording" — the closest thing to a clone that works
 * offline and costs nothing.
 *
 * Supertone's own builder does this properly, server-side, for $49 a voice, and
 * as of August 2026 it sells none. There is no public style encoder, so a
 * recording cannot be turned into a style directly. What CAN be done with what
 * is already installed is a search: speak a candidate blend of the ten presets,
 * embed it with a speaker model, compare with the recording, keep the best.
 *
 * Which is why the copy here promises a resemblance and not a clone, and why
 * the match score is shown rather than hidden: it is the one honest number in
 * the feature.
 *
 * The recording happens in the renderer because that is where the microphone
 * is, and it goes straight to main as raw Float32 — no file, no encoder, and
 * nothing leaves the machine.
 */

import { useEffect, useRef, useState } from "react";
import { Download, Loader2, Mic, Play, Square, Upload, Wand2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI, TtsProgress } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** Long enough for a stable speaker embedding; the builder asks for a minute
 * and the models need a few seconds. */
const MAX_SECONDS = 40;
const MIN_SECONDS = 4;

interface Clip {
  samples: Float32Array;
  sampleRate: number;
  seconds: number;
}

function toBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function VoiceFromRecording({
  lang,
  onSaved,
  onError,
  /** Speak a voice id — the parent owns playback so one Stop stops everything. */
  onListen,
  speaking,
  onStop,
}: {
  lang: string;
  onSaved: (id: string) => void;
  onError: (message: string) => void;
  onListen: (voiceId: string) => void;
  speaking: boolean;
  onStop: () => void;
}): JSX.Element {
  const [matcher, setMatcher] = useState<{ installed: boolean; bytes: number; available: boolean } | null>(null);
  const [dl, setDl] = useState<TtsProgress | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState<Clip | null>(null);
  const [fit, setFit] = useState<{ step: number; total: number; best: number } | null>(null);
  const [result, setResult] = useState<{
    parts: { id: string; weight: number }[];
    score: number;
    baseScore: number;
  } | null>(null);
  const [name, setName] = useState("");
  const [gender, setGender] = useState<"F" | "M">("F");

  const ctxRef = useRef<AudioContext | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void api()
      ?.tts.matcherStatus()
      .then((s) => setMatcher(s ?? null));
    const off = api()?.tts.onMatcherProgress((p) => {
      setDl(p.done ? null : p);
      if (p.done) {
        if (p.error && p.error !== "Download cancelled") onError(p.error);
        void api()
          ?.tts.matcherStatus()
          .then((s) => setMatcher(s ?? null));
      }
    });
    const offFit = api()?.tts.onFitProgress((p) => setFit(p));
    return () => {
      off?.();
      offFit?.();
      stopRef.current?.();
    };
  }, []);

  const startRecording = async (): Promise<void> => {
    setResult(null);
    setClip(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      // 16 kHz straight from the graph: the speaker model's own rate, so
      // nothing has to resample a clip this long twice.
      const ctx = new AudioContext({ sampleRate: 16_000 });
      ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (e) => {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        const n = chunks.reduce((t, c) => t + c.length, 0);
        setSeconds(Math.floor(n / ctx.sampleRate));
        if (n >= MAX_SECONDS * ctx.sampleRate) stopRef.current?.();
      };
      src.connect(node);
      node.connect(ctx.destination);
      setRecording(true);
      setSeconds(0);
      stopRef.current = () => {
        stopRef.current = null;
        node.onaudioprocess = null;
        node.disconnect();
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
        setRecording(false);
        const n = chunks.reduce((t, c) => t + c.length, 0);
        const samples = new Float32Array(n);
        let at = 0;
        for (const c of chunks) {
          samples.set(c, at);
          at += c.length;
        }
        setClip({ samples, sampleRate: 16_000, seconds: n / 16_000 });
      };
    } catch (err) {
      onError(err instanceof Error ? err.message : "No microphone");
    }
  };

  /** Any file the browser can decode — including whatever you recorded
   * elsewhere. Decoding here means no ffmpeg in main. */
  const pickFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setResult(null);
    try {
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const mono = buf.getChannelData(0);
      setClip({
        samples: new Float32Array(mono),
        sampleRate: buf.sampleRate,
        seconds: buf.duration,
      });
      void ctx.close();
    } catch {
      onError("Could not read that audio file.");
    }
  };

  const runFit = (): void => {
    if (!clip) return;
    setFit({ step: 0, total: 1, best: 0 });
    setResult(null);
    void api()
      ?.tts.fitVoice({
        samplesBase64: toBase64(clip.samples),
        sampleRate: clip.sampleRate,
        lang,
      })
      .then((r) => {
        setFit(null);
        if (!r?.ok || !r.parts) {
          if (r?.error && r.error !== "Cancelled") onError(r.error);
          return;
        }
        setResult({ parts: r.parts, score: r.score ?? 0, baseScore: r.baseScore ?? 0 });
      });
  };

  const listen = (): void => {
    if (!result) return;
    void api()
      ?.tts.previewMix({ parts: result.parts, gender })
      .then((r) => {
        if (r?.ok && r.id) onListen(r.id);
        else if (r?.error) onError(r.error);
      });
  };

  const save = (): void => {
    if (!result) return;
    void api()
      ?.tts.mixVoice({ parts: result.parts, name, gender })
      .then((r) => {
        if (r?.ok && r.id) {
          setName("");
          setResult(null);
          setClip(null);
          onSaved(r.id);
        } else if (r?.error) onError(r.error);
      });
  };

  const mb = ((matcher?.bytes ?? 0) / 1e6).toFixed(0);

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="text-sm font-medium">Build a voice from your recording</div>
      <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
        Say anything for {MIN_SECONDS}–{MAX_SECONDS} seconds. The app then
        searches for the blend of its ten voices that sounds most like you — a
        family resemblance, not a copy, and all of it on this machine.
      </p>

      {matcher && !matcher.available ? (
        <p className="mt-2 text-[12px] text-muted-foreground">
          Not available on this platform.
        </p>
      ) : !matcher?.installed ? (
        <div className="mt-2">
          {dl ? (
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
                <div
                  className="h-full rounded-full bg-link transition-[width]"
                  style={{ width: `${dl.percent}%` }}
                />
              </div>
              <span className="text-[11px] tabular-nums text-muted-foreground">{dl.percent}%</span>
              <button
                type="button"
                onClick={() => void api()?.tts.cancelMatcher()}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                title="Cancel"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDl({ loaded: 0, total: 1, percent: 0 });
                void api()?.tts.installMatcher();
              }}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[13px] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            >
              <Download className="size-3.5" />
              Download the voice matcher ({mb} MB)
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => (recording ? stopRef.current?.() : void startRecording())}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors",
                recording
                  ? "border-destructive/50 text-destructive"
                  : "border-border hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
              )}
            >
              {recording ? <Square className="size-3.5" /> : <Mic className="size-3.5" />}
              {recording ? `Stop (${seconds}s)` : "Record"}
            </button>
            <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              <Upload className="size-3.5" />
              Audio file
              <input type="file" accept="audio/*" onChange={pickFile} className="hidden" />
            </label>
            {clip && !recording && (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {clip.seconds.toFixed(0)}s recorded
              </span>
            )}
            <span className="flex-1" />
            {fit ? (
              <button
                type="button"
                onClick={() => void api()?.tts.cancelFit()}
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:text-destructive"
              >
                <X className="size-3.5" />
                Stop the search
              </button>
            ) : (
              <button
                type="button"
                onClick={runFit}
                disabled={!clip || clip.seconds < MIN_SECONDS}
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] transition-colors hover:bg-black/[0.04] disabled:opacity-40 dark:hover:bg-white/[0.06]"
              >
                <Wand2 className="size-3.5" />
                Find my voice
              </button>
            )}
          </div>

          {fit && (
            <div className="mt-2 flex items-center gap-2">
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
                <div
                  className="h-full rounded-full bg-brand transition-[width]"
                  style={{ width: `${Math.round((fit.step / Math.max(1, fit.total)) * 100)}%` }}
                />
              </div>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {fit.step}/{fit.total} · match {(fit.best * 100).toFixed(0)}%
              </span>
            </div>
          )}

          {result && (
            <div className="mt-2 space-y-2">
              <p className="text-[12px] text-muted-foreground">
                Closest match <span className="text-foreground">{(result.score * 100).toFixed(0)}%</span>
                {result.score > result.baseScore + 0.005 && (
                  <> — the search improved on the best single voice ({(result.baseScore * 100).toFixed(0)}%)</>
                )}
                . Listen before you keep it: a low number sounds like someone
                else entirely.
              </p>
              <div className="flex items-center gap-1.5">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name it"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground/60 focus:border-link"
                />
                {(["F", "M"] as const).map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGender(g)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[12px] transition-colors",
                      gender === g
                        ? "border-brand/40 bg-brand/[0.08] text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {g === "F" ? "Female" : "Male"}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => (speaking ? onStop() : listen())}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                >
                  {speaking ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                  Listen
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={!name.trim()}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] transition-colors hover:bg-black/[0.04] disabled:opacity-40 dark:hover:bg-white/[0.06]"
                >
                  Keep it
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
