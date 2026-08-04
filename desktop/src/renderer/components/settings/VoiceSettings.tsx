/**
 * Settings → Voice: everything spoken, in one place.
 *
 * Dictation (speech → text) and the app's voice (text → speech) used to be
 * crammed into the mic button's hover panel, which had grown taller than the
 * window. The panel keeps only the microphone choice; the engines, models and
 * voices live here, where a 400 MB download has room to explain itself.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Download, Loader2, Play, Square, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";
import { SttModelPicker } from "@/components/chat/SttModelPicker";
import type { ElectronAPI, TtsProgress, TtsStatus } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const TEST_PHRASE =
  "Привет! Я голос Code Monet. <breath> Вот так я читаю ответы — с паузами и интонацией.";

export function VoiceSettings(): JSX.Element {
  // ── STT (dictation) ────────────────────────────────────────────────────
  const [engine, setEngine] = useState("local");
  const [endpoint, setEndpoint] = useState("");
  const [sttKey, setSttKey] = useState("");
  const [model, setModel] = useState("");
  const [localModel, setLocalModel] = useState("Xenova/whisper-base");
  const [nativeModel, setNativeModel] = useState("gigaam-v3-rnnt-punct");
  const [language, setLanguage] = useState("");

  // ── TTS (the app's voice) ──────────────────────────────────────────────
  const [tts, setTts] = useState<TtsStatus | null>(null);
  const [ttsVoice, setTtsVoice] = useState("F1");
  const [ttsProgress, setTtsProgress] = useState<TtsProgress | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<AudioBufferSourceNode | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    void (async () => {
      const saved = await api()?.stt.getSettings();
      if (saved) {
        setEngine(saved.engine);
        setEndpoint(saved.endpoint);
        setSttKey(saved.key);
        setModel(saved.model);
        setLocalModel(saved.localModel);
        setNativeModel(saved.nativeModel);
        setLanguage(saved.language);
        if (saved.ttsVoice) setTtsVoice(saved.ttsVoice);
      }
      setTts((await api()?.tts.status()) ?? null);
    })();
    return api()?.tts.onProgress((p) => {
      setTtsProgress(p.done ? null : p);
      if (p.done) {
        if (p.error && p.error !== "Download cancelled") setTtsError(p.error);
        void api()
          ?.tts.status()
          .then((s) => setTts(s ?? null));
      }
    });
  }, []);

  const save = (field: string, value: string, set: (v: string) => void): void => {
    set(value);
    void api()?.stt.setSettings({ [field]: value });
  };

  const installTts = (): void => {
    setTtsError(null);
    setTtsProgress({ loaded: 0, total: 1, percent: 0 });
    void api()
      ?.tts.install(ttsVoice)
      .then((r) => {
        if (!r.ok && r.error && r.error !== "Download cancelled") setTtsError(r.error);
        void api()
          ?.tts.status()
          .then((s) => setTts(s ?? null));
      });
  };

  const stopTest = (): void => {
    try {
      audioRef.current?.stop();
    } catch {
      /* not playing */
    }
    audioRef.current = null;
    setSpeaking(false);
  };

  const playTest = async (): Promise<void> => {
    stopTest();
    setSpeaking(true);
    setTtsError(null);
    try {
      const r = await api()?.tts.speak({
        text: TEST_PHRASE,
        voice: ttsVoice,
        lang: "ru",
        steps: 8,
      });
      if (!r?.ok || !r.samplesBase64) {
        setTtsError(r?.error || "Synthesis failed");
        return;
      }
      const bin = atob(r.samplesBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const samples = new Float32Array(bytes.buffer);
      const ctx = (ctxRef.current ??= new AudioContext());
      const buf = ctx.createBuffer(1, samples.length, r.sampleRate ?? 44100);
      buf.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => setSpeaking(false);
      audioRef.current = src;
      src.start();
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : "Playback failed");
      setSpeaking(false);
    } finally {
      if (!audioRef.current) setSpeaking(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* ── Dictation ─────────────────────────────────────────────────── */}
      <section>
        <h3 className="mb-1 text-sm font-semibold text-foreground">Dictation</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Speech to text for the mic button and Voice Mode. On-device engines
          need no key and keep audio on this machine.
        </p>
        <div className="mb-3 flex flex-col gap-1">
          {(
            [
              ["ondevice", "On-device — GigaAM (best for Russian)"],
              ["local", "On-device — Whisper (WASM)"],
              ["cloud", "Cloud — OpenAI-compatible API"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => save("engine", id, setEngine)}
              className="flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
            >
              <span className="flex w-4 justify-center">
                {engine === id && <Check className="size-3.5 text-link" />}
              </span>
              {label}
            </button>
          ))}
        </div>

        {engine === "ondevice" ? (
          <div className="max-w-md">
            <SttModelPicker
              selected={nativeModel}
              onSelect={(v) => save("nativeModel", v, setNativeModel)}
            />
          </div>
        ) : engine === "local" ? (
          <div className="flex max-w-md gap-1.5">
            <Select
              ariaLabel="Local model"
              value={localModel}
              onChange={(v) => save("localModel", v, setLocalModel)}
              className="w-3/5 justify-between"
              options={[
                { value: "Xenova/whisper-tiny", label: "Fast (~147 MB)" },
                { value: "Xenova/whisper-base", label: "Balanced (~280 MB)" },
                { value: "Xenova/whisper-small", label: "Accurate (~926 MB)" },
              ]}
            />
            <Select
              ariaLabel="Language"
              value={language}
              onChange={(v) => save("language", v, setLanguage)}
              className="w-2/5 justify-between"
              options={[
                { value: "", label: "Auto language" },
                { value: "ru", label: "Русский" },
                { value: "en", label: "English" },
              ]}
            />
          </div>
        ) : (
          <div className="flex max-w-md flex-col gap-1.5">
            <input
              value={endpoint}
              onChange={(e) => save("endpoint", e.target.value, setEndpoint)}
              placeholder="https://api.groq.com/openai/v1/audio/transcriptions"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground/60 focus:border-link"
            />
            <div className="flex gap-1.5">
              <input
                value={sttKey}
                onChange={(e) => save("key", e.target.value, setSttKey)}
                placeholder="API key"
                type="password"
                spellCheck={false}
                className="w-1/2 rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground/60 focus:border-link"
              />
              <input
                value={model}
                onChange={(e) => save("model", e.target.value, setModel)}
                placeholder="whisper-large-v3"
                spellCheck={false}
                className="w-1/2 rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground/60 focus:border-link"
              />
            </div>
          </div>
        )}
      </section>

      {/* ── The app's voice ───────────────────────────────────────────── */}
      <section>
        <h3 className="mb-1 text-sm font-semibold text-foreground">Voice</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Supertonic 3 — on-device, 31 languages, expression tags. One shared
          model (~398 MB), then each voice is a 0.3 MB download.
        </p>

        {!tts ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : !tts.installed ? (
          <div className="max-w-md">
            {ttsProgress ? (
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
                  <div
                    className="h-full rounded-full bg-link transition-[width]"
                    style={{ width: `${ttsProgress.percent}%` }}
                  />
                </div>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {ttsProgress.percent}%
                </span>
                <button
                  type="button"
                  onClick={() => void api()?.tts.cancelInstall()}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  title="Cancel"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={installTts}
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[13px] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              >
                <Download className="size-3.5" />
                Download the voice model (398 MB)
              </button>
            )}
          </div>
        ) : (
          <div className="max-w-md space-y-3">
            <div className="grid grid-cols-2 gap-1">
              {tts.voices.map((v: TtsStatus["voices"][number]) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => {
                    save("ttsVoice", v.id, setTtsVoice);
                    if (!v.installed)
                      void api()
                        ?.tts.installVoice(v.id)
                        .then(() => api()?.tts.status())
                        .then((s) => setTts(s ?? null));
                  }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[13px] transition-colors",
                    ttsVoice === v.id
                      ? "border-link/40 bg-link/[0.06]"
                      : "border-transparent hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
                  )}
                >
                  <span className="flex w-4 justify-center">
                    {ttsVoice === v.id && <Check className="size-3.5 text-link" />}
                  </span>
                  <span className="flex-1">{v.label}</span>
                  {!v.installed && (
                    <Download className="size-3 text-muted-foreground/60" />
                  )}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => (speaking ? stopTest() : void playTest())}
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[13px] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              >
                {speaking ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                {speaking ? "Stop" : "Test the voice"}
              </button>
              <button
                type="button"
                onClick={() =>
                  void api()
                    ?.tts.remove()
                    .then(() => api()?.tts.status())
                    .then((s) => setTts(s ?? null))
                }
                title="Delete the downloaded model"
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
                Remove
              </button>
            </div>
          </div>
        )}
        {ttsError && (
          <div className="mt-2 max-w-md rounded-md bg-destructive/10 px-2 py-1 text-[12px] text-destructive">
            {ttsError}
          </div>
        )}
      </section>
    </div>
  );
}
