/**
 * "Clone your voice" — record here, run one command, import the result.
 *
 * The app cannot do this itself and says so: cloning means gradient descent
 * through the model, and onnxruntime does inference only. So this card does the
 * parts the app IS good at — capturing clean audio and putting a ready-to-run
 * project on disk next to the model — and hands over a command.
 *
 * Deliberately not hidden behind "advanced": it is the only route to your own
 * voice that works at all now that Supertone's builder sells nothing.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Copy, FolderOpen, Mic, Square, Upload, Wand2 } from "@/components/icons/hg";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** macOS and Linux have no bare `python`/`pip` — the commands shown must be
 * the ones that exist, or the first step fails before the cloner runs. */
const isMac = ((): boolean => {
  const p = (window as unknown as { electronAPI?: { platform?: string } })
    .electronAPI?.platform;
  return p !== "win32";
})();


const MAX_SECONDS = 40;
const MIN_SECONDS = 8;

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

export function VoiceCloner({
  lang,
  onError,
}: {
  lang: string;
  onError: (message: string) => void;
}): JSX.Element {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState<Clip | null>(null);
  const [name, setName] = useState("");
  const [ready, setReady] = useState<{ dir: string; command: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  const startRecording = async (): Promise<void> => {
    setReady(null);
    setClip(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Every one of these "improvements" changes the timbre, which is the
        // one thing being measured here.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const ctx = new AudioContext({ sampleRate: 16_000 });
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

  /** Any file the browser can decode — including what you recorded elsewhere.
   * Decoding here means main needs no ffmpeg. */
  const pickFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setReady(null);
    try {
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      setClip({
        samples: new Float32Array(buf.getChannelData(0)),
        sampleRate: buf.sampleRate,
        seconds: buf.duration,
      });
      void ctx.close();
    } catch {
      onError("Could not read that audio file.");
    }
  };

  const prepare = (): void => {
    if (!clip) return;
    void api()
      ?.tts.prepareCloner({
        samplesBase64: toBase64(clip.samples),
        sampleRate: clip.sampleRate,
        name,
        lang,
      })
      .then((r) => {
        if (!r?.ok || !r.dir || !r.command) {
          if (r?.error) onError(r.error);
          return;
        }
        setReady({ dir: r.dir, command: r.command });
      });
  };

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-1.5">
        <Wand2 className="size-3.5 text-brand" />
        <span className="text-sm font-medium">Clone your voice</span>
      </div>
      <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
        Record {MIN_SECONDS}–{MAX_SECONDS} seconds of anything you like. The app
        writes a small Python project next to the model that optimises a voice
        style until it sounds like you, and you import the result above. It has
        to be a separate program: cloning needs gradients through the model, and
        the app's runtime only does inference.
      </p>

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
            {clip.seconds.toFixed(0)}s
            {clip.seconds < MIN_SECONDS && " — a bit short"}
          </span>
        )}
        <span className="flex-1" />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name it"
          spellCheck={false}
          className="w-28 rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground/60 focus:border-link"
        />
        <button
          type="button"
          onClick={prepare}
          disabled={!clip}
          className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] transition-colors hover:bg-black/[0.04] disabled:opacity-40 dark:hover:bg-white/[0.06]"
        >
          Prepare the project
        </button>
      </div>

      {ready && (
        <div className="mt-2.5 space-y-1.5">
          <p className="text-[12px] text-muted-foreground">
            Ready in <span className="text-foreground">{ready.dir}</span>. Install
            once (
            <code className="text-foreground">
              {isMac ? "pip3" : "pip"} install -r requirements.txt
            </code>
            ),
            then run — an hour on a CPU, and Ctrl-C keeps the best voice so far:
          </p>
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-black/[0.03] px-2 py-1 text-[11px] dark:bg-white/[0.04]">
              {ready.command}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(ready.command);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            >
              {copied ? <Check className="size-3.5 text-brand" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => void api()?.tts.revealCloner()}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            >
              <FolderOpen className="size-3.5" />
              Open folder
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/80">
            It prints a similarity as it goes: ~0.3 is a stranger, ~0.6 is
            recognisably related, past ~0.75 is a good likeness. Then import the
            JSON it writes. README.md in that folder has the details.
          </p>
        </div>
      )}
    </div>
  );
}
