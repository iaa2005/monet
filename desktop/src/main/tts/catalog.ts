/**
 * The on-device voice: Supertonic 3, and where its files come from.
 *
 * Chosen over everything else surveyed (Piper, Kokoro, OpenAudio, Orpheus…)
 * because it is the only model that has all four at once: Russian among its
 * 31 languages, inline expression tags (<laugh>, <sigh>, <breath>), pure ONNX
 * on CPU (~99M params, measured RTF ≈ 0.3 on this class of machine), and a
 * licence that permits shipping (MIT code, OpenRAIL-M weights).
 *
 * One shared model (~398 MB), eleven voices as ~290 KB style tensors — so
 * "several voices to choose from" costs nothing after the first download.
 *
 * Pure data + arithmetic, like the STT catalogue; the download and checksum
 * machinery is shared with it in spirit: exact sizes, sha256 where HuggingFace
 * publishes one (the LFS files), size-only for the small JSONs.
 */

export interface TtsFile {
  /** Path inside the repo; the basename is what it is saved as. */
  path: string;
  bytes: number;
  /** HuggingFace `lfs.oid` — absent for the small non-LFS JSONs. */
  sha256?: string;
}

export const TTS_REPO = "Supertone/supertonic-3";

/** The shared model: four networks plus the text-processing tables. */
export const TTS_MODEL_FILES: TtsFile[] = [
  {
    path: "onnx/duration_predictor.onnx",
    bytes: 3_700_147,
    sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db",
  },
  {
    path: "onnx/text_encoder.onnx",
    bytes: 36_416_150,
    sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff",
  },
  {
    path: "onnx/vector_estimator.onnx",
    bytes: 256_534_781,
    sha256: "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c",
  },
  {
    path: "onnx/vocoder.onnx",
    bytes: 101_424_195,
    sha256: "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba",
  },
  { path: "onnx/tts.json", bytes: 8_253 },
  { path: "onnx/unicode_indexer.json", bytes: 277_676 },
];

export interface TtsVoiceInfo {
  /** Style id, also the filename stem: F1…F6, M1…M5. */
  id: string;
  label: string;
  bytes: number;
}

/** The eleven preset styles. Labels stay neutral — the voice is the label. */
export const TTS_VOICES: TtsVoiceInfo[] = [
  { id: "F1", label: "Female 1", bytes: 292_046 },
  { id: "F2", label: "Female 2", bytes: 292_423 },
  { id: "F3", label: "Female 3", bytes: 290_794 },
  { id: "F4", label: "Female 4", bytes: 291_808 },
  { id: "F5", label: "Female 5", bytes: 291_479 },
  { id: "M1", label: "Male 1", bytes: 291_748 },
  { id: "M2", label: "Male 2", bytes: 292_055 },
  { id: "M3", label: "Male 3", bytes: 290_198 },
  { id: "M4", label: "Male 4", bytes: 291_522 },
  { id: "M5", label: "Male 5", bytes: 291_469 },
];

export const DEFAULT_TTS_VOICE = "F1";

export function voiceFile(id: string): TtsFile | null {
  const v = TTS_VOICES.find((x) => x.id === id);
  return v ? { path: `voice_styles/${v.id}.json`, bytes: v.bytes } : null;
}

export function ttsModelBytes(): number {
  return TTS_MODEL_FILES.reduce((n, f) => n + f.bytes, 0);
}

export function ttsFileUrl(f: TtsFile): string {
  return `https://huggingface.co/${TTS_REPO}/resolve/main/${f.path}`;
}

export function ttsFileName(f: TtsFile): string {
  return f.path.split("/").pop() as string;
}

/**
 * The expression tags Supertonic actually understands, per its README. The
 * chat model is told to use exactly these; anything else a model invents is
 * stripped before synthesis rather than read aloud as angle brackets.
 */
export const TTS_TAGS = ["<laugh>", "<sigh>", "<breath>"] as const;

/**
 * Split off expression tags for display: the UI hides them, the voice keeps
 * them. Unknown look-alike tags (<whisper>…) are dropped from BOTH — reading
 * "less-than whisper" aloud is worse than losing the nuance.
 */
export function stripTtsTags(text: string): string {
  return text
    .replace(/<\/?(?:laugh|sigh|breath|pause|whisper|slow|fast|loud|quiet|chuckle|gasp|yawn|cough)>/gi, "")
    .replace(/[ \t]{2,}/g, " ");
}

/** What the synthesiser should see: known tags kept, unknown ones removed. */
export function textForSpeech(text: string): string {
  const known = new Set(TTS_TAGS.map((t) => t.toLowerCase()));
  return text
    .replace(/<\/?[a-z_]{2,12}>/gi, (m) => {
      const bare = m.replace("/", "").toLowerCase();
      return known.has(bare) ? bare : "";
    })
    .replace(/[ \t]{2,}/g, " ");
}
