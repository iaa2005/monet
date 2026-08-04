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
import { INTERRUPT_MARK, useChatStore } from "@/stores/chatStore";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

type Phase = "listening" | "thinking" | "speaking" | "error";

/** One line per event, greppable: the whole conversation becomes a timeline. */
function vlog(event: string, detail?: unknown): void {
  // One STRING per line: objects logged as objects reach the CDP collector
  // as the literal word "Object", which is no detail at all.
  console.log(
    `[voice] ${new Date().toISOString().slice(11, 23)} ${event} ${
      detail === undefined ? "" : typeof detail === "string" ? detail : JSON.stringify(detail)
    }`,
  );
}

/**
 * Sentences ready to speak: complete ones during streaming, the tail after.
 *
 * Two things are NOT for the voice. Service marks ("⏹️ Generation
 * interrupted.") — hearing that in English mid-conversation is jarring and
 * useless. And fragments under ~20 characters: the flow-matching synthesiser
 * mumbles on tiny inputs (a real "Да, умею." came out as noise), so short
 * sentences ride along with the next one instead of going out alone.
 */
function completeSentences(text: string, done: boolean): string[] {
  const clean = text
    .split(INTERRUPT_MARK).join(" ")
    .replace(/⏹️?\s*Generation interrupted\.?/gi, " ");
  const parts = clean.split(/(?<=[.!?…])\s+/);
  if (!done && parts.length > 0) parts.pop();
  const out: string[] = [];
  let buf = "";
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    buf = buf ? `${buf} ${t}` : t;
    if (buf.length >= 20) {
      out.push(buf);
      buf = "";
    }
  }
  // A short tail: speak it only when the reply is finished — mid-stream it
  // will grow into a full chunk on the next tick.
  if (buf && done) out.push(buf);
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s));
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
  /** Decoded audio waiting to play: synthesis runs AHEAD of playback. It used
   * to start only when the previous sentence finished sounding, and those
   * 1.5–2 s of synthesis were an audible hole between every two sentences. */
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const synthBusyRef = useRef(false);
  const playingRef = useRef(false);
  /** Exactly one recording loop. It used to be restarted from three places —
   * after transcribing, from the speech queue, from the reply watcher — and
   * the parallel loops each heard the same utterance: the message went out
   * twice and the second send stopped the first one's run. */
  const loopRef = useRef(false);
  const watchRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Everything already spoken, by TEXT. Tool-heavy runs rebuild transcript
   * messages with fresh ids, which reset any id-keyed counter and replayed
   * the whole reply; the words themselves do not change identity. */
  const spokenTextsRef = useRef<Set<string>>(new Set());

  const stopPlayback = (): void => {
    queueRef.current = [];
    audioQueueRef.current = [];
    playingRef.current = false;
    try {
      sourceRef.current?.stop();
    } catch {
      /* not playing */
    }
    sourceRef.current = null;
  };

  /** Stage 1: synthesise ahead — one sentence in flight, results queued. */
  const synthPump = async (): Promise<void> => {
    if (synthBusyRef.current || !alive.current) return;
    const text = queueRef.current.shift();
    if (!text) return;
    synthBusyRef.current = true;
    const tReq = Date.now();
    vlog("tts-request", text.slice(0, 60));
    try {
      const settings = await api()?.stt.getSettings();
      // Starving speaker → fewer flow-matching steps: the first sentence of
      // a reply lands ~40% sooner; once audio is queued ahead, quality wins.
      const urgent = audioQueueRef.current.length === 0 && !playingRef.current;
      const r = await api()?.tts.speak({
        text,
        voice: settings?.ttsVoice || "F1",
        lang: "na",
        steps: urgent ? 4 : 8,
      });
      if (!alive.current) return;
      if (r?.ok && r.samplesBase64) {
        vlog("tts-done", { ms: Date.now() - tReq, synthMs: r.ms });
        const bin = atob(r.samplesBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const samples = new Float32Array(bytes.buffer);
        const ctx = (audioCtxRef.current ??= new AudioContext());
        const buf = ctx.createBuffer(1, samples.length, r.sampleRate ?? 44100);
        buf.copyToChannel(samples, 0);
        audioQueueRef.current.push(buf);
        void playPump();
      }
    } finally {
      synthBusyRef.current = false;
    }
    void synthPump();
  };

  /** Stage 2: play what is ready, in order, with no gap in between. */
  const playPump = (): void => {
    if (playingRef.current || !alive.current) return;
    const buf = audioQueueRef.current.shift();
    if (!buf) {
      if (
        phaseRef.current === "speaking" &&
        !synthBusyRef.current &&
        queueRef.current.length === 0 &&
        !useChatStore.getState().isStreaming
      ) {
        setPh("listening");
      }
      return;
    }
    playingRef.current = true;
    setPh("speaking");
    const ctx = (audioCtxRef.current ??= new AudioContext());
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => {
      vlog("play-end");
      playingRef.current = false;
      sourceRef.current = null;
      playPump();
    };
    sourceRef.current = src;
    vlog("play-start", { seconds: +buf.duration.toFixed(2) });
    src.start();
  };

  const pump = (): void => {
    void synthPump();
  };

  /** Watch the streaming reply and feed finished sentences to the voice. */
  const watchReply = (): void => {
    if (watchRef.current) clearInterval(watchRef.current);
    // Anchor to the reply that does not exist yet. Right after send() the
    // newest assistant message is still the PREVIOUS reply, and feeding it
    // to the queue replayed the last answer before the new one arrived.
    const st0 = useChatStore.getState();
    const baseline = [...st0.messages].reverse().find((m) => m.role === "assistant")?.id;
    vlog("watch-start", { baseline: baseline ?? null });
    // Per-message sentence counters: a run with tools produces SEVERAL
    // assistant chunks (text → tool → text…), and a single counter over
    // "the latest one" skipped or repeated whatever sat between tools. A
    // chunk that is no longer the newest message is final by definition —
    // it gets spoken right away, while the tool is still running.
    const spoken = new Map<string, number>();
    watchRef.current = setInterval(() => {
      const st = useChatStore.getState();
      // The voice conversation's OWN chat — switching chats must not
      // re-point the loop at whatever is on screen.
      const sid = st.voiceSessionId;
      const sess = sid ? st.sessions[sid] : undefined;
      const msgs = sess?.messages ?? st.messages;
      const streaming = sess ? sess.isStreaming : st.isStreaming;
      const bi = baseline ? msgs.findIndex((m) => m.id === baseline) : -1;
      const fresh = msgs
        .slice(bi + 1)
        .filter((m) => m.role === "assistant" && m.content);
      let queuedTotal = 0;
      for (const m of fresh) {
        const isNewest = msgs[msgs.length - 1]?.id === m.id;
        const done = !isNewest || !streaming;
        const sentences = completeSentences(m.content, done);
        let n = spoken.get(m.id) ?? 0;
        while (n < sentences.length) {
          const key = sentences[n].replace(/\s+/g, " ").trim();
          n += 1;
          if (spokenTextsRef.current.has(key)) continue;
          spokenTextsRef.current.add(key);
          vlog("sentence-queued", key.slice(0, 60));
          queueRef.current.push(key);
          pump();
        }
        spoken.set(m.id, n);
        queuedTotal += n;
      }
      if (!streaming) {
        vlog("stream-done", { queued: queuedTotal });
        if (watchRef.current) clearInterval(watchRef.current);
        watchRef.current = null;
        if (!playingRef.current && queueRef.current.length === 0) {
          setPh("listening");
        }
      }
    }, 150);
  };

  /** One utterance: record until ~1.3 s of silence, transcribe, send. */
  const listen = async (): Promise<void> => {
    if (!alive.current || loopRef.current) return;
    loopRef.current = true;
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
      vlog("loop-start");

      let heard = false;
      let voicedRun = 0;
      let silentSince = Date.now();
      // Barge-in wants PROOF, not a blip: Chromium's echo cancellation only
      // subtracts WebRTC audio, so the app's own voice from the speakers
      // reaches this mic as ordinary sound and was stopping the playback
      // mid-word. Direct speech into the mic is both louder and sustained;
      // speaker echo at conversation volume is neither.
      let bargeTicks = 0;
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
        // Barge-in: half a second of loud, uninterrupted voice — not one
        // frame of the app hearing itself.
        if (phaseRef.current === "speaking") {
          bargeTicks = rms > 0.06 ? bargeTicks + 1 : 0;
          if (bargeTicks >= 8) {
            vlog("barge-in", { rms: +rms.toFixed(3) });
            bargeTicks = 0;
            stopPlayback();
            setPh("listening");
          }
        } else {
          bargeTicks = 0;
        }
        if (phaseRef.current !== "listening") return;
        if (voiced) {
          // Three consecutive voiced ticks (~180 ms): a keystroke is one.
          voicedRun += 1;
          if (voicedRun >= 3) {
            if (!heard) vlog("speech-start", { rms: +rms.toFixed(3) });
            heard = true;
          }
          silentSince = Date.now();
        } else {
          voicedRun = 0;
        }
        if (!voiced && heard && Date.now() - silentSince > 1300) {
          heard = false;
          voicedRun = 0;
          vlog("speech-end");
          clearInterval(meter);
          rec.stop();
        }
      }, 60);

      rec.onstop = () => {
        clearInterval(meter);
        loopRef.current = false;
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
          const tStt = Date.now();
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
          vlog("transcribed", { ms: Date.now() - tStt, text: res.text.slice(0, 80) });
          const clean = res.text.trim();
          // Only the unpronounceable is noise: «Да» and «Есть» are answers.
          // Keystroke junk is mostly caught earlier by the sustained-voice gate.
          if (clean.replace(/[^\p{L}\p{N}]/gu, "").length < 1) {
            vlog("discarded-junk", clean);
            setPh("listening");
            void listen();
            return;
          }
          setNote(clean);
          const st = useChatStore.getState();
          const sid = st.voiceSessionId;
          const running = sid ? st.sessions[sid]?.isStreaming : st.isStreaming;
          if (running && sid) {
            // Mid-run words are a steer for the run, not a new message: the
            // watcher stays anchored and keeps narrating.
            const r = await api()?.chat.inject(sid, clean);
            vlog("injected", { ok: r?.ok });
            if (!r?.ok) {
              onSend(clean);
              vlog("sent");
              watchReply();
            }
          } else {
            onSend(clean);
            vlog("sent");
            watchReply();
          }
          // Keep the mic loop alive for barge-in while the reply speaks.
          void listen();
        })();
      };
    } catch (err) {
      loopRef.current = false;
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
    speaking: "Говорю — говори, чтобы перебить",
    error: "Ошибка",
  };

  return (
    <div className="fixed bottom-24 right-6 z-[120] flex w-64 flex-col items-center rounded-2xl border border-border bg-card/95 p-4 shadow-2xl backdrop-blur-md">
      <button
        type="button"
        onClick={onClose}
        title="Выйти из голосового режима"
        className="absolute right-2 top-2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
      >
        <X className="size-4" />
      </button>

      {/* The orb: outer breathing glow + inner level-driven core. */}
      <button
        type="button"
        onClick={() => {
          if (phaseRef.current === "speaking") {
            stopPlayback();
            setPh("listening");
          } else onClose();
        }}
        className="relative mt-1 flex size-24 items-center justify-center"
        title={phase === "speaking" ? "Перебить" : "Выйти"}
      >
        <div
          className={cn(
            "absolute inset-0 rounded-full bg-gradient-to-br opacity-30 blur-xl transition-all duration-500",
            colors[phase],
            phase === "thinking" && "animate-pulse",
          )}
        />
        <div
          className={cn(
            "absolute inset-2 rounded-full bg-gradient-to-br opacity-40 transition-all duration-300",
            colors[phase],
          )}
          style={{ transform: `scale(${phase === "listening" ? orbScale : 1})` }}
        />
        <div
          className={cn(
            "relative size-12 rounded-full bg-gradient-to-br shadow-xl transition-all duration-200",
            colors[phase],
            phase === "speaking" && "animate-[pulse_1.2s_ease-in-out_infinite]",
          )}
          style={{
            transform: `scale(${phase === "listening" ? orbScale : phase === "speaking" ? 1.06 : 1})`,
          }}
        />
      </button>

      <div className="mt-3 text-xs font-medium text-foreground">{label[phase]}</div>
      {note && (
        <div className="mt-1 line-clamp-2 max-w-full px-1 text-center text-[11px] text-muted-foreground">
          {note}
        </div>
      )}
    </div>
  );
}
