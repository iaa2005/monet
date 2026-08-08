/**
 * The on-device voice: Supertonic 3, and where its files come from.
 *
 * Chosen over everything else surveyed (Piper, Kokoro, OpenAudio, Orpheus…)
 * because it is the only model that has all four at once: Russian among its
 * 31 languages, inline expression tags (<laugh>, <sigh>, <breath>), pure ONNX
 * on CPU (~99M params, measured RTF ≈ 0.3 on this class of machine), and a
 * licence that permits shipping (MIT code, OpenRAIL-M weights).
 *
 * One shared model (~398 MB), ten voices as ~290 KB style tensors — so
 * "several voices to choose from" costs nothing after the first download.
 * (The model card says eleven; the repo holds ten. F6 exists only in
 * supertonic-2's styles.)
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

export const TTS_REPO = "iaa2005/supertonic-3";

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
  /** Style id, also the filename stem: F1…F5, M1…M5. The first letter is the
   * gender, and the app reads it — a spoken Russian reply agrees with it. */
  id: string;
  /** The voice's own name, as Supertone publishes it. */
  name: string;
  /** One line of what it sounds like. */
  desc: string;
  bytes: number;
}

/**
 * The ten preset styles. "Female 1" told you nothing; these are the names and
 * characters Supertone gives them in the official demo (the supertonic-3
 * Space, script.js: VOICE_DESCRIPTIONS), abridged to one line each.
 */
export const TTS_VOICES: TtsVoiceInfo[] = [
  { id: "F1", name: "Sarah", desc: "Calm, slightly low; steady and composed.", bytes: 292_046 },
  { id: "F2", name: "Lily", desc: "Bright and cheerful; playful, youthful energy.", bytes: 292_423 },
  { id: "F3", name: "Jessica", desc: "Clear announcer style; articulate, broadcast-ready.", bytes: 290_794 },
  { id: "F4", name: "Olivia", desc: "Crisp and confident; expressive, strong delivery.", bytes: 291_808 },
  { id: "F5", name: "Emily", desc: "Kind and gentle; soft-spoken and soothing.", bytes: 291_479 },
  { id: "M1", name: "Alex", desc: "Lively and upbeat; confident, clear standard tone.", bytes: 291_748 },
  { id: "M2", name: "James", desc: "Deep and robust; calm, serious, grounded.", bytes: 292_055 },
  { id: "M3", name: "Robert", desc: "Polished and authoritative; confident, trustworthy.", bytes: 290_198 },
  { id: "M4", name: "Sam", desc: "Soft and neutral; youthful and approachable.", bytes: 291_522 },
  { id: "M5", name: "Daniel", desc: "Warm and soft-spoken; calm, natural storytelling.", bytes: 291_469 },
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

export { TTS_TAGS, stripTtsTags, textForSpeech } from "@shared/voice-tags.js";
