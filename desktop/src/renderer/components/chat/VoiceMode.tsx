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
import { ClipboardList, MessageSquare, Square, X } from "lucide-react";
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
  const levelRef = useRef(0);
  const outLevelRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const outAnalyserRef = useRef<AnalyserNode | null>(null);
  const [note, setNote] = useState<string>("");
  /** The sentence sounding right now — the pill's live caption. */
  const [subtitle, setSubtitle] = useState<string>("");
  // Away = the voice chat is not the one on screen: the pill grows a
  // return button and narrates what the run is doing over there.
  const away = useChatStore(
    (st) => !!st.voiceSessionId && st.currentSessionId !== st.voiceSessionId,
  );
  const planWaiting = useChatStore((st) => {
    const sid = st.voiceSessionId;
    const msgs = sid ? st.sessions[sid]?.messages : undefined;
    if (!msgs) return false;
    return msgs.some(
      (m) =>
        m.toolCall?.name === "ExitPlanMode" &&
        (m.toolCall.status === "running" || m.toolCall.status === "pending"),
    );
  });
  const runningTool = useChatStore((st) => {
    const sid = st.voiceSessionId;
    const msgs = sid ? st.sessions[sid]?.messages : undefined;
    if (!msgs) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const tc = msgs[i].toolCall;
      if (tc && (tc.status === "running" || tc.status === "pending")) {
        const inp = tc.input as Record<string, unknown>;
        const detail =
          (typeof inp.url === "string" && inp.url) ||
          (typeof inp.file_path === "string" && inp.file_path) ||
          (typeof inp.command === "string" && inp.command) ||
          "";
        return `${tc.name}${detail ? ` — ${String(detail).slice(0, 48)}` : ""}`;
      }
      if (tc) break;
    }
    return null;
  });

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
  const audioQueueRef = useRef<{ buf: AudioBuffer; text: string }[]>([]);
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
  /** Barge-in mutes the REST of the current reply, not just the sentence
   * that was sounding: the queue kept refilling and she talked on. Lifted
   * when a new reply starts. */
  const mutedRef = useRef(false);
  /** Plans already announced by voice, by tool-call id. */
  const planSpokenRef = useRef<Set<string>>(new Set());

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
    if (synthBusyRef.current || !alive.current || mutedRef.current) return;
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
        audioQueueRef.current.push({ buf, text });
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
    if (mutedRef.current) {
      audioQueueRef.current = [];
      return;
    }
    const next = audioQueueRef.current.shift();
    if (!next) {
      // The VOICE chat's stream, not whatever chat is on screen: switching
      // chats made this read the other chat's idle state and cut the phase
      // (and the narration) short.
      const stv = useChatStore.getState();
      const vsid = stv.voiceSessionId;
      const vStreaming = vsid ? stv.sessions[vsid]?.isStreaming : stv.isStreaming;
      if (
        phaseRef.current === "speaking" &&
        !synthBusyRef.current &&
        queueRef.current.length === 0 &&
        !vStreaming
      ) {
        setPh("listening");
      }
      return;
    }
    playingRef.current = true;
    setPh("speaking");
    setSubtitle(next.text);
    const ctx = (audioCtxRef.current ??= new AudioContext());
    const src = ctx.createBufferSource();
    src.buffer = next.buf;
    // Through an analyser, so the wave breathes with the spoken audio too.
    if (!outAnalyserRef.current) {
      outAnalyserRef.current = ctx.createAnalyser();
      outAnalyserRef.current.fftSize = 512;
      outAnalyserRef.current.connect(ctx.destination);
    }
    src.connect(outAnalyserRef.current);
    src.onended = () => {
      vlog("play-end");
      playingRef.current = false;
      sourceRef.current = null;
      playPump();
    };
    sourceRef.current = src;
    vlog("play-start", { seconds: +next.buf.duration.toFixed(2) });
    src.start();
  };

  const pump = (): void => {
    void synthPump();
  };

  /** Watch the streaming reply and feed finished sentences to the voice. */
  const watchReply = (): void => {
    mutedRef.current = false;
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
    let lastDiag = 0;
    // The stream must be SEEN alive before its silence means "over": send()
    // only flips the on-screen session's flag optimistically, so with another
    // chat open the voice session reads false until DeepSeek's first token —
    // and the watcher was killing itself 150 ms after the send.
    let sawStreaming = false;
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
      // Watchdog for the silent-watch bug: once a second, say what we see.
      if (Date.now() - lastDiag > 1000) {
        lastDiag = Date.now();
        vlog("watch-tick", {
          sid: sid ?? null,
          haveSession: !!sess,
          msgs: msgs.length,
          fresh: fresh.length,
          streaming,
          muted: mutedRef.current,
        });
      }
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
          if (mutedRef.current) continue; // counted, never voiced
          vlog("sentence-queued", key.slice(0, 60));
          queueRef.current.push(key);
          pump();
        }
        spoken.set(m.id, n);
        queuedTotal += n;
      }
      // A plan waiting for approval is worth a sentence: the card sits in
      // the chat, and with the user away nothing else would say so.
      for (const m of msgs) {
        const tc = m.toolCall;
        if (
          tc?.name === "ExitPlanMode" &&
          (tc.status === "running" || tc.status === "pending") &&
          !planSpokenRef.current.has(tc.id)
        ) {
          planSpokenRef.current.add(tc.id);
          const title =
            typeof tc.input?.title === "string" ? (tc.input.title as string) : "";
          const phrase = title
            ? `Я подготовила план «${title}». Вернись в чат — посмотри и одобри.`
            : "План готов и ждёт твоего одобрения в чате.";
          if (!mutedRef.current && !spokenTextsRef.current.has(phrase)) {
            spokenTextsRef.current.add(phrase);
            vlog("plan-announced", title || "(untitled)");
            queueRef.current.push(phrase);
            pump();
          }
        }
      }
      if (streaming) sawStreaming = true;
      if (!streaming && (sawStreaming || queuedTotal > 0)) {
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
        levelRef.current = rms;
        const voiced = rms > 0.02;
        // Barge-in: half a second of loud, uninterrupted voice — not one
        // frame of the app hearing itself.
        if (phaseRef.current === "speaking") {
          bargeTicks = rms > 0.05 ? bargeTicks + 1 : 0;
          if (bargeTicks >= 6) {
            vlog("barge-in", { rms: +rms.toFixed(3) });
            bargeTicks = 0;
            // Mute the WHOLE remaining reply — not just this sentence.
            mutedRef.current = true;
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
          // Two letters minimum: «Да» and «Ок» pass, a stray «а» from a
          // breath or the chair creaking does not.
          if (clean.replace(/[^\p{L}\p{N}]/gu, "").length < 2) {
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
            // Inject: it rides into the run between steps, shows up in the
            // chat via the user_message event, and interrupts nothing. The
            // red "Stopped" came from the OTHER path — chat:send into a busy
            // session aborts its run.
            const r = await api()?.chat.inject(sid, clean);
            vlog("injected", { ok: r?.ok });
            if (!r?.ok) {
              // The run ended between our check and the inject — normal send.
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

  // ONE soft blurred wave (Tesla-Grok style), amplitude = the louder of the
  // two voices. Canvas, because CSS can only breathe a bar up and down.
  useEffect(() => {
    let raf = 0;
    const colors: Record<Phase, [number, number, number]> = {
      listening: [16, 185, 129],
      thinking: [245, 158, 11],
      speaking: [167, 92, 250],
      error: [244, 63, 94],
    };
    const draw = (t: number): void => {
      const canvas = canvasRef.current;
      const c = canvas?.getContext("2d");
      if (canvas && c) {
        const w = (canvas.width = canvas.offsetWidth);
        const h = (canvas.height = canvas.offsetHeight);
        c.clearRect(0, 0, w, h);
        const ph = phaseRef.current;
        // Each phase owns its wave: your voice moves it only while she
        // listens, hers only while she speaks, and thinking breathes by
        // itself — a mic rustle must not wiggle the orange wave.
        const glow =
          ph === "listening"
            ? Math.min(1, levelRef.current * 5)
            : ph === "speaking"
              ? Math.min(1, outLevelRef.current * 3.5)
              : 0.18 + 0.14 * Math.sin(t * 0.003);
        const [r, g, b] = colors[ph];
        const amp = 10 + glow * (h * 0.6);
        c.beginPath();
        c.moveTo(0, h);
        for (let x = 0; x <= w; x += 4) {
          // A single slow hump travelling right, softly enveloped at edges.
          const env = Math.sin((x / w) * Math.PI) ** 1.5;
          const y =
            h -
            10 -
            (0.6 + 0.4 * Math.sin(x * 0.006 + t * 0.0018)) * amp * env;
          c.lineTo(x, y);
        }
        c.lineTo(w, h);
        c.closePath();
        const grad = c.createLinearGradient(0, h - 110, 0, h);
        grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},${0.35 + glow * 0.45})`);
        c.fillStyle = grad;
        c.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    alive.current = true;
    const data = new Uint8Array(256);
    const outMeter = setInterval(() => {
      const a = outAnalyserRef.current;
      if (!a || !playingRef.current) {
        outLevelRef.current = 0;
        return;
      }
      a.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      outLevelRef.current = Math.sqrt(sum / data.length);
    }, 60);
    void listen();
    return () => {
      alive.current = false;
      clearInterval(outMeter);
      stopPlayback();
      if (watchRef.current) clearInterval(watchRef.current);
      recRef.current?.stream && recRef.current.state !== "inactive" && recRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void audioCtxRef.current?.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <>
      {/* The blurred voice wave along the bottom, over every chat. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[110]">
        <canvas ref={canvasRef} className="block h-32 w-full blur-xl" />
      </div>
      {/* The status pill — the only clickable part. Away from the voice
          chat it grows: a way back, the tool being run, and live captions
          of what she is saying. */}
      <div className="fixed bottom-3 right-4 z-[120] flex max-w-md flex-col gap-1 rounded-2xl border border-border bg-card/90 px-3 py-2 shadow-lg backdrop-blur-md">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              phase === "listening" && "animate-pulse bg-emerald-500",
              phase === "thinking" && "animate-pulse bg-amber-500",
              phase === "speaking" && "animate-pulse bg-violet-500",
              phase === "error" && "bg-red-500",
            )}
          />
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">
            {label[phase]}
          </span>
          {away && planWaiting && (
            <button
              type="button"
              onClick={() => {
                const sid = useChatStore.getState().voiceSessionId;
                if (sid) useChatStore.getState().setCurrentSessionId(sid);
              }}
              title="План ждёт одобрения — открыть чат"
              className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 hover:bg-amber-500/25 dark:text-amber-400"
            >
              <ClipboardList className="size-3" />
              План
            </button>
          )}
          {away && !planWaiting && (
            <button
              type="button"
              onClick={() => {
                const sid = useChatStore.getState().voiceSessionId;
                if (sid) useChatStore.getState().setCurrentSessionId(sid);
              }}
              title="Вернуться в голосовой чат"
              className="flex items-center gap-1 rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground dark:bg-white/[0.07]"
            >
              <MessageSquare className="size-3" />
              В чат
            </button>
          )}
          {phase === "speaking" && (
            <button
              type="button"
              onClick={() => {
                stopPlayback();
                setPh("listening");
              }}
              title="Перебить"
              className="rounded-full p-1 text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
            >
              <Square className="size-3" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Выйти из голосового режима"
            className="rounded-full p-1 text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <X className="size-3.5" />
          </button>
        </div>
        {phase === "thinking" && runningTool && (
          <div className="truncate pl-4 text-[11px] text-muted-foreground">
            {runningTool}
          </div>
        )}
        {phase === "speaking" && subtitle && (
          <div className="line-clamp-2 pl-4 text-[11px] leading-snug text-muted-foreground">
            {subtitle}
          </div>
        )}
      </div>
    </>
  );
}
