/**
 * Voice Mode — a conversation, not a dictation.
 *
 * One loop: listen until you stop talking → GigaAM turns it into text → the
 * message goes through the normal send path → the reply is spoken sentence by
 * sentence WHILE it streams, so the first sentence sounds ~a second after the
 * model starts. Speaking and listening overlap: the mic stays open with echo
 * cancellation, and sustained voice while the app talks is a barge-in — the
 * playback stops mid-word and your words win.
 *
 * The orb is the whole UI. Its colour is the state (green listening, amber
 * thinking, violet speaking), its scale is the microphone level, a click
 * interrupts or exits. No transcript here — the chat behind it is the
 * transcript.
 */

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

type Phase = "listening" | "thinking" | "speaking" | "error";

/** Sentences ready to speak: complete ones during streaming, the tail after. */
function completeSentences(text: string, done: boolean): string[] {
  const parts = text.split(/(?<=[.!?…])\s+/);
  if (!done && parts.length > 0) parts.pop();
  return parts.map((s) => s.trim()).filter((s) => s.length > 1);
}

export function VoiceMode({
  onSend,
  onClose,
}: {
  onSend: (text: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>("listening");
  const [level, setLevel] = useState(0);
  const [note, setNote] = useState<string>("");

  const alive = useRef(true);
  const phaseRef = useRef<Phase>("listening");
  const setPh = (p: Phase): void => {
    phaseRef.current = p;
    setPhase(p);
  };
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const queueRef = useRef<string[]>([]);
  const playingRef = useRef(false);
  const spokenRef = useRef(0); // sentences of the current reply already queued
  const watchRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPlayback = (): void => {
    queueRef.current = [];
    playingRef.current = false;
    try {
      sourceRef.current?.stop();
    } catch {
      /* not playing */
    }
    sourceRef.current = null;
  };

  /** Speak the queue head; chains itself until the queue drains. */
  const pump = async (): Promise<void> => {
    if (playingRef.current || !alive.current) return;
    const text = queueRef.current.shift();
    if (!text) {
      // Nothing left: if the model has also finished, go back to listening.
      if (phaseRef.current === "speaking" && !useChatStore.getState().isStreaming) {
        setPh("listening");
        void listen();
      }
      return;
    }
    playingRef.current = true;
    setPh("speaking");
    const settings = await api()?.stt.getSettings();
    const r = await api()?.tts.speak({
      text,
      voice: settings?.ttsVoice || "F1",
      lang: "na",
      steps: 6,
    });
    if (!alive.current) return;
    if (!r?.ok || !r.samplesBase64) {
      playingRef.current = false;
      void pump();
      return;
    }
    const bin = atob(r.samplesBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const samples = new Float32Array(bytes.buffer);
    const ctx = (audioCtxRef.current ??= new AudioContext());
    const buf = ctx.createBuffer(1, samples.length, r.sampleRate ?? 44100);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => {
      playingRef.current = false;
      sourceRef.current = null;
      void pump();
    };
    sourceRef.current = src;
    src.start();
  };

  /** Watch the streaming reply and feed finished sentences to the voice. */
  const watchReply = (): void => {
    spokenRef.current = 0;
    if (watchRef.current) clearInterval(watchRef.current);
    watchRef.current = setInterval(() => {
      const st = useChatStore.getState();
      const msgs = st.messages;
      const last = [...msgs].reverse().find((m) => m.role === "assistant");
      if (!last?.content) return;
      const done = !st.isStreaming;
      const sentences = completeSentences(last.content, done);
      while (spokenRef.current < sentences.length) {
        queueRef.current.push(sentences[spokenRef.current]);
        spokenRef.current += 1;
        void pump();
      }
      if (done) {
        if (watchRef.current) clearInterval(watchRef.current);
        watchRef.current = null;
        // A reply with no speakable text still returns to listening.
        if (!playingRef.current && queueRef.current.length === 0) {
          setPh("listening");
          void listen();
        }
      }
    }, 250);
  };

  /** One utterance: record until ~1.3 s of silence, transcribe, send. */
  const listen = async (): Promise<void> => {
    if (!alive.current) return;
    try {
      const settings = await api()?.stt.getSettings();
      const stream =
        streamRef.current ??
        (await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(settings?.deviceId ? { deviceId: { exact: settings.deviceId } } : {}),
            echoCancellation: true,
            noiseSuppression: true,
          },
        }));
      streamRef.current = stream;
      const ctx = (audioCtxRef.current ??= new AudioContext());
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const rec = new MediaRecorder(stream);
      recRef.current = rec;
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.start();

      let heard = false;
      let silentSince = Date.now();
      const meter = setInterval(() => {
        if (!alive.current) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        setLevel(rms);
        const voiced = rms > 0.02;
        // Barge-in: sustained voice while the app is talking wins.
        if (phaseRef.current === "speaking" && voiced) {
          stopPlayback();
          setPh("listening");
        }
        if (phaseRef.current !== "listening") return;
        if (voiced) {
          heard = true;
          silentSince = Date.now();
        } else if (heard && Date.now() - silentSince > 1300) {
          heard = false;
          clearInterval(meter);
          rec.stop();
        }
      }, 60);

      rec.onstop = () => {
        clearInterval(meter);
        if (!alive.current) return;
        void (async () => {
          setPh("thinking");
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          if (blob.size < 2000) {
            setPh("listening");
            void listen();
            return;
          }
          const buf = await blob.arrayBuffer();
          const dctx = new AudioContext({ sampleRate: 16000 });
          const audio = await dctx.decodeAudioData(buf);
          const pcm = new Float32Array(audio.getChannelData(0));
          void dctx.close();
          const res = await api()?.stt.transcribePcm({
            modelId: settings?.nativeModel || "gigaam-v3-rnnt-punct",
            samples: pcm,
            sampleRate: 16000,
          });
          if (!alive.current) return;
          if (!res?.ok || !res.text) {
            setNote(res?.error || "Не расслышала — попробуй ещё раз.");
            setPh("listening");
            void listen();
            return;
          }
          setNote(res.text);
          onSend(res.text);
          watchReply();
          // Keep the mic loop alive for barge-in while the reply speaks.
          void listen();
        })();
      };
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Микрофон недоступен");
      setPh("error");
    }
  };

  useEffect(() => {
    alive.current = true;
    void listen();
    return () => {
      alive.current = false;
      stopPlayback();
      if (watchRef.current) clearInterval(watchRef.current);
      recRef.current?.stream && recRef.current.state !== "inactive" && recRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void audioCtxRef.current?.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const orbScale = 1 + Math.min(0.45, level * 3.5);
  const colors: Record<Phase, string> = {
    listening: "from-emerald-400/70 to-teal-500/70",
    thinking: "from-amber-400/70 to-orange-500/70",
    speaking: "from-violet-400/70 to-fuchsia-500/70",
    error: "from-red-400/70 to-rose-500/70",
  };
  const label: Record<Phase, string> = {
    listening: "Слушаю…",
    thinking: "Думаю…",
    speaking: "Говорю — начни говорить, чтобы перебить",
    error: "Ошибка",
  };

  return (
    <div className="fixed inset-0 z-[120] flex flex-col items-center justify-center bg-background/80 backdrop-blur-md">
      <button
        type="button"
        onClick={onClose}
        title="Выйти из голосового режима"
        className="absolute right-6 top-6 rounded-full p-2 text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
      >
        <X className="size-5" />
      </button>

      {/* The orb: outer breathing ring + inner level-driven core. */}
      <button
        type="button"
        onClick={() => {
          if (phaseRef.current === "speaking") {
            stopPlayback();
            setPh("listening");
          } else onClose();
        }}
        className="relative flex size-56 items-center justify-center"
        title={phase === "speaking" ? "Перебить" : "Выйти"}
      >
        <div
          className={cn(
            "absolute inset-0 rounded-full bg-gradient-to-br opacity-30 blur-2xl transition-all duration-500",
            colors[phase],
            phase === "thinking" && "animate-pulse",
          )}
        />
        <div
          className={cn(
            "absolute inset-6 rounded-full bg-gradient-to-br opacity-40 transition-all duration-300",
            colors[phase],
          )}
          style={{ transform: `scale(${phase === "listening" ? orbScale : 1})` }}
        />
        <div
          className={cn(
            "relative size-28 rounded-full bg-gradient-to-br shadow-2xl transition-all duration-200",
            colors[phase],
            phase === "speaking" && "animate-[pulse_1.2s_ease-in-out_infinite]",
          )}
          style={{
            transform: `scale(${phase === "listening" ? orbScale : phase === "speaking" ? 1.06 : 1})`,
          }}
        />
      </button>

      <div className="mt-8 text-sm font-medium text-foreground">{label[phase]}</div>
      {note && (
        <div className="mt-2 max-w-md px-6 text-center text-xs text-muted-foreground">
          {note}
        </div>
      )}
    </div>
  );
}
