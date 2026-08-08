/**
 * Settings → Voice: everything spoken, in one place.
 *
 * Dictation (speech → text) and the app's voice (text → speech) used to be
 * crammed into the mic button's hover panel, which had grown taller than the
 * window. The panel keeps only the microphone choice; the engines, models and
 * voices live here, where a 400 MB download has room to explain itself.
 */

import { useEffect, useRef, useState } from "react";
import {
  Blend,
  Check,
  Download,
  ExternalLink,
  Loader2,
  Play,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";
import { SttModelPicker } from "@/components/chat/SttModelPicker";
import type { ElectronAPI, TtsProgress, TtsStatus } from "@/types/electron";
import { WHISPER_TIERS, DEFAULT_WHISPER } from "@shared/whisper-tier";
import { AUTO_LANG, TTS_LANGS, speechLangFor } from "@shared/tts-langs";
import { ART_SIZE, voiceCells } from "@/lib/voice-art";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const BUILDER_URL = "https://supertonic.supertone.ai/voice-builder";

/** Two, because a Russian sentence tells you nothing about an English voice
 * and vice versa. Anything else falls back to English. */
const TEST_PHRASE: Record<string, string> = {
  ru: "Привет! Я голос Code Monet. <breath> Вот так я читаю ответы — с паузами и интонацией.",
  en: "Hi! This is the Code Monet voice. <breath> Replies sound like this — with pauses and intonation.",
};

/**
 * The voice's picture — its own style tensor where there is one, its id
 * otherwise. See lib/voice-art.ts and shared/voice-map.ts.
 *
 * The middle of the range is "same as the average voice" and draws nothing:
 * distance from it is strength, side is colour. So a blend of two voices
 * visibly sits between their two pictures.
 */
function VoiceArt({
  voice,
  className,
}: {
  voice: { id: string; art?: string };
  className?: string;
}): JSX.Element {
  const cells = voiceCells(voice);
  return (
    <svg
      viewBox={`0 0 ${ART_SIZE} ${ART_SIZE}`}
      aria-hidden
      // Without this the cells land on fractional device pixels and the whole
      // map turns to mush — 144 antialiased edges in 48 px.
      shapeRendering="crispEdges"
      className={cn("shrink-0 rounded-lg bg-brand/[0.06]", className)}
    >
      {cells.map((c, i) => {
        const d = Math.abs(c - 8);
        if (d <= 1) return null;
        const cls =
          c > 8
            ? d <= 3
              ? "fill-brand/40"
              : "fill-brand"
            : d <= 3
              ? "fill-foreground/20"
              : "fill-foreground/45";
        return (
          <rect
            key={i}
            x={i % ART_SIZE}
            y={Math.floor(i / ART_SIZE)}
            width={1}
            height={1}
            className={cls}
          />
        );
      })}
    </svg>
  );
}

/** Female / male, which is not decoration: a spoken Russian reply agrees with
 * it («я сделал» / «я сделала»), and the app reads it off the voice id. */
function GenderPick({
  value,
  onChange,
}: {
  value: "F" | "M";
  onChange: (g: "F" | "M") => void;
}): JSX.Element {
  return (
    <>
      {(["F", "M"] as const).map((g) => (
        <button
          key={g}
          type="button"
          onClick={() => onChange(g)}
          className={cn(
            "rounded-md border px-2 py-1 text-[12px] transition-colors",
            value === g
              ? "border-brand/40 bg-brand/[0.08] text-foreground"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {g === "F" ? "Female" : "Male"}
        </button>
      ))}
    </>
  );
}

export function VoiceSettings(): JSX.Element {
  // ── STT (dictation) ────────────────────────────────────────────────────
  const [engine, setEngine] = useState("local");
  const [endpoint, setEndpoint] = useState("");
  const [sttKey, setSttKey] = useState("");
  const [model, setModel] = useState("");
  const [localModel, setLocalModel] = useState(DEFAULT_WHISPER);
  const [nativeModel, setNativeModel] = useState("gigaam-v3-rnnt-punct");
  const [language, setLanguage] = useState("");

  // ── TTS (the app's voice) ──────────────────────────────────────────────
  const [tts, setTts] = useState<TtsStatus | null>(null);
  const [ttsVoice, setTtsVoice] = useState("F1");
  const [ttsLang, setTtsLang] = useState(AUTO_LANG);
  const [ttsProgress, setTtsProgress] = useState<TtsProgress | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [newName, setNewName] = useState("");
  const [newGender, setNewGender] = useState<"F" | "M">("F");
  const [mixA, setMixA] = useState("F1");
  const [mixB, setMixB] = useState("M2");
  const [mixW, setMixW] = useState(50);
  const [mixName, setMixName] = useState("");
  const [mixGender, setMixGender] = useState<"F" | "M">("F");
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
        if (saved.ttsLang) setTtsLang(saved.ttsLang);
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

  const refreshTts = (): void => {
    void api()
      ?.tts.status()
      .then((s) => setTts(s ?? null));
  };

  const importVoice = (): void => {
    setTtsError(null);
    void api()
      ?.tts.importVoice({ name: newName, gender: newGender })
      .then((r) => {
        if (r?.error) setTtsError(r.error);
        if (r?.ok && r.id) {
          setNewName("");
          save("ttsVoice", r.id, setTtsVoice);
        }
        refreshTts();
      });
  };

  // The blend pickers can only offer what is installed, and that list is not
  // known until the status arrives — a value outside it leaves the trigger
  // blank, which is how this shipped the first time.
  useEffect(() => {
    const ids = (tts?.voices ?? []).filter((v) => v.installed).map((v) => v.id);
    if (ids.length < 2) return;
    setMixA((a) => (ids.includes(a) ? a : ids[0]));
    setMixB((b) => (ids.includes(b) && b !== ids[0] ? b : ids[ids.length - 1]));
  }, [tts]);

  const mixParts = (): { id: string; weight: number }[] => [
    { id: mixA, weight: 100 - mixW },
    { id: mixB, weight: mixW },
  ];

  /** Hear the blend before it has a name: main writes it under a fixed
   * unregistered id, so it is speakable and never appears in the picker. */
  const playMix = async (): Promise<void> => {
    setTtsError(null);
    const r = await api()?.tts.previewMix({ parts: mixParts(), gender: mixGender });
    if (!r?.ok || !r.id) {
      setTtsError(r?.error ?? "Blend failed");
      return;
    }
    await playTest(r.id);
  };

  const saveMix = (): void => {
    setTtsError(null);
    void api()
      ?.tts.mixVoice({ parts: mixParts(), name: mixName, gender: mixGender })
      .then((r) => {
        if (r?.error) setTtsError(r.error);
        if (r?.ok && r.id) {
          setMixName("");
          save("ttsVoice", r.id, setTtsVoice);
        }
        refreshTts();
      });
  };

  const playTest = async (voice = ttsVoice): Promise<void> => {
    stopTest();
    setSpeaking(true);
    setTtsError(null);
    try {
      // The phrase follows the setting, so "auto" demonstrates itself: the
      // language comes from the text. Which text, on auto, is a guess — the
      // Russian recogniser or a Russian dictation language says Russian.
      const guess = engine === "ondevice" || language === "ru" ? "ru" : "en";
      const text = TEST_PHRASE[ttsLang === AUTO_LANG ? guess : ttsLang] ?? TEST_PHRASE.en;
      const r = await api()?.tts.speak({
        text,
        voice,
        lang: speechLangFor(text, ttsLang),
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

  // Only what is actually on disk can be blended: the maths reads the style
  // files. A preset arrives the moment it is selected once.
  const mixable = (tts?.voices ?? []).filter((v) => v.installed);
  const enoughToMix = mixable.length >= 2;

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
              options={WHISPER_TIERS.map((m) => ({
                value: m.id,
                label: m.label,
              }))}
            />
            {/* Whisper understands every one of these, so the list is the same
                one the voice uses — three entries was an accident of history,
                not a limit of the model. */}
            <Select
              ariaLabel="Language"
              value={language}
              onChange={(v) => save("language", v, setLanguage)}
              className="w-2/5 justify-between"
              contentClassName="max-h-72"
              options={[
                { value: "", label: "Auto" },
                ...TTS_LANGS.map((l) => ({
                  value: l.code,
                  label: l.name,
                  icon: <span className="text-[13px] leading-none">{l.flag}</span>,
                })),
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

        {/* What the synthesiser is TOLD the text is: it does not detect the
            language, the tag around the text decides the mouth. */}
        <div className="mb-3 flex max-w-md items-center justify-between gap-2 rounded-xl border border-border p-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">Speech language</div>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
              The accent the voice reads with. On auto it follows each
              sentence's own script.
            </p>
          </div>
          <Select
            ariaLabel="Speech language"
            value={ttsLang}
            onChange={(v) => save("ttsLang", v, setTtsLang)}
            className="shrink-0 justify-between"
            contentClassName="max-h-72"
            options={[
              { value: AUTO_LANG, label: "Auto" },
              ...TTS_LANGS.map((l) => ({
                value: l.code,
                label: l.name,
                icon: <span className="text-[13px] leading-none">{l.flag}</span>,
              })),
            ]}
          />
        </div>

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
            {/* One column: a name, a line about the voice and a picture do not
                fit side by side without the description wrapping mid-word. */}
            <div className="flex flex-col gap-1.5">
              {tts.voices.map((v: TtsStatus["voices"][number]) => (
                <div
                  key={v.id}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border p-2 transition-colors",
                    ttsVoice === v.id
                      ? "border-brand/40 bg-brand/[0.06]"
                      : "border-border hover:border-foreground/20",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      save("ttsVoice", v.id, setTtsVoice);
                      if (!v.installed)
                        void api()
                          ?.tts.installVoice(v.id)
                          .then(refreshTts);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <VoiceArt voice={v} className="size-12" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-[13px] font-medium">{v.name}</span>
                        {v.custom && (
                          <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                            yours
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                        {v.desc}
                      </span>
                    </span>
                  </button>
                  {ttsVoice === v.id ? (
                    <Check className="size-4 shrink-0 text-brand" />
                  ) : !v.installed ? (
                    <Download className="size-3.5 shrink-0 text-muted-foreground/60" />
                  ) : null}
                  {v.custom && (
                    <button
                      type="button"
                      title="Delete this voice"
                      onClick={() =>
                        void api()?.tts.removeVoice(v.id).then(() => {
                          if (ttsVoice === v.id) save("ttsVoice", "F1", setTtsVoice);
                          refreshTts();
                        })
                      }
                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Blending. A style is a point in a latent space and the average
                of two points is another voice — the only route to a voice of
                your own that is free, offline and needs no encoder. */}
            <div className="rounded-xl border border-border p-3">
              <div className="text-sm font-medium">Blend a new voice</div>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                Two voices, mixed. The result is a voice that did not exist,
                built out of files already on this machine.
              </p>
              {!enoughToMix && (
                // Only the first voice comes with the model; the rest arrive
                // when selected. Nothing to blend with one.
                <p className="mt-2 text-[12px] text-muted-foreground/80">
                  Pick a second voice from the list above first — each is a
                  0.3 MB download, and a blend needs two.
                </p>
              )}
              <div
                className={cn(
                  "mt-2.5 flex items-center gap-2",
                  !enoughToMix && "pointer-events-none opacity-40",
                )}
              >
                <Select
                  ariaLabel="First voice"
                  value={mixA}
                  onChange={setMixA}
                  className="w-28 shrink-0 justify-between"
                  contentClassName="max-h-72"
                  options={mixable.map((v) => ({ value: v.id, label: v.name }))}
                />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={mixW}
                  aria-label="Blend"
                  onChange={(e) => setMixW(Number(e.target.value))}
                  className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-border accent-brand [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand"
                />
                <Select
                  ariaLabel="Second voice"
                  value={mixB}
                  onChange={setMixB}
                  className="w-28 shrink-0 justify-between"
                  contentClassName="max-h-72"
                  options={mixable.map((v) => ({ value: v.id, label: v.name }))}
                />
              </div>
              <div className="mt-1 text-center text-[11px] tabular-nums text-muted-foreground">
                {100 - mixW}% / {mixW}%
              </div>
              <div
                className={cn(
                  "mt-2 flex items-center gap-1.5",
                  !enoughToMix && "pointer-events-none opacity-40",
                )}
              >
                <input
                  value={mixName}
                  onChange={(e) => setMixName(e.target.value)}
                  placeholder="Name it"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground/60 focus:border-link"
                />
                <GenderPick value={mixGender} onChange={setMixGender} />
                <button
                  type="button"
                  onClick={() => (speaking ? stopTest() : void playMix())}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                >
                  {speaking ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                  Listen
                </button>
                <button
                  type="button"
                  onClick={saveMix}
                  disabled={!mixName.trim() || mixA === mixB}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] transition-colors hover:bg-black/[0.04] disabled:opacity-40 dark:hover:bg-white/[0.06]"
                >
                  <Blend className="size-3.5" />
                  Save
                </button>
              </div>
            </div>

            {/* Importing. The file is the whole voice — the 398 MB model above
                speaks with whichever style pair it is handed. */}
            <div className="rounded-xl border border-border p-3">
              <div className="text-sm font-medium">Import a voice file</div>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                Any Supertonic 3 style JSON — 0.3 MB, and it joins the list with
                nothing else to install.
              </p>
              <div className="mt-2 flex items-center gap-1.5">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Name it"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground/60 focus:border-link"
                />
                <GenderPick value={newGender} onChange={setNewGender} />
                <button
                  type="button"
                  onClick={importVoice}
                  disabled={!newName.trim()}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] transition-colors hover:bg-black/[0.04] disabled:opacity-40 dark:hover:bg-white/[0.06]"
                >
                  <Upload className="size-3.5" />
                  Import JSON
                </button>
              </div>
              {/* The honest state of the official route, August 2026. */}
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
                Supertone's own{" "}
                <button
                  type="button"
                  onClick={() => void api()?.shell.openExternal(BUILDER_URL)}
                  className="inline-flex items-center gap-0.5 text-link hover:underline"
                >
                  voice builder
                  <ExternalLink className="size-2.5" />
                </button>{" "}
                turns a minute of your audio into one of these files, but it
                charges $49 per voice and currently sells none ("Purchases
                Unavailable"); it closes on 31 August 2026. You can listen there
                and not download. A file you already have keeps working forever
                — the synthesis is here, not there.
              </p>
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
