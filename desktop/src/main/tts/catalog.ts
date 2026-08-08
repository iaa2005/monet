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
  /** Its voice map (shared/voice-map.ts), precomputed from the published
   * style file so a voice has a face BEFORE it is downloaded — and so the
   * ten of them cost no file reads at all. */
  art: string;
}

/**
 * The ten preset styles. "Female 1" told you nothing; these are the names and
 * characters Supertone gives them in the official demo (the supertonic-3
 * Space, script.js: VOICE_DESCRIPTIONS), abridged to one line each.
 */
export const TTS_VOICES: TtsVoiceInfo[] = [
  { id: "F1", name: "Sarah", desc: "Calm, slightly low; steady and composed.", bytes: 292_046,
    art: "5b0894076a898ea98b92a8e744cda8b80454f7a30968b955c6c836b5ea256a6f7690669cf8910b235082a6c9b22877589c7969a7978bdb87d3458b03672757d8bf7668fdc7b089d2" },
  { id: "F2", name: "Lily", desc: "Bright and cheerful; playful, youthful energy.", bytes: 292_423,
    art: "aa07963399cb8ea4742860d927bdc1582888d7440b6d875496f554058331655581a1ffbd66410a7162808c799bc557c95e64769b19378a68b0d6af494e0346986f37797d98a24885" },
  { id: "F3", name: "Jessica", desc: "Clear announcer style; articulate, broadcast-ready.", bytes: 290_794,
    art: "bf46f63e8b9c478d85373bf5685bd77f01a5eb785d78fa36c0d87607a50336a448c45abb79602839706077f59c175bd4ca6b8874c896588ff73d9955874765758ff385e1e4b22be6" },
  { id: "F4", name: "Olivia", desc: "Crisp and confident; expressive, strong delivery.", bytes: 291_808,
    art: "e03895779953864587f979676654989abc4a352b38b6038a5fc7a8a6790c39c4a970d3668919f0887f9db4c94365777794a776866c85196003d8af984af89695909fa84554a09739" },
  { id: "F5", name: "Emily", desc: "Kind and gentle; soft-spoken and soothing.", bytes: 291_479,
    art: "b65cbb2d4136790968154e10f9115ba2872f158cf28350f64e0a8957965b4a946b80352b62c2f5976f8f43857c897b056368b9c7defca5a00f4a51cad4abf43782558480a9609939" },
  { id: "M1", name: "Alex", desc: "Lively and upbeat; confident, clear standard tone.", bytes: 291_748,
    art: "0ec508f175cb89e66897d4de75bfb54259a0fd92b93bc696a978888a5672b43fb05fbdb9bc99093574604f35d5c887287f543b587137c97ff2948f657c46098a8f108d6f8a9f47a1" },
  { id: "M2", name: "James", desc: "Deep and robust; calm, serious, grounded.", bytes: 292_055,
    art: "48f257f2bac977d37787d38874ce71573586f88a0ab48b2670f839bb79a3c82d638f6897a5bd4c7685654f249a6a63788fa716274226b96bf2899034999c1c896ea1ac6f68bf77c8" },
  { id: "M3", name: "Robert", desc: "Polished and authoritative; confident, trustworthy.", bytes: 290_198,
    art: "60fc66c94f338664acfe49094b804c7dfeed05b6c272068b8505b8e527ffe9806a4965105b2fd4eedc8eb03e2763e7ea50a7c544631507980f7952fc7186fd5480ad7724081bd34e" },
  { id: "M4", name: "Sam", desc: "Soft and neutral; youthful and approachable.", bytes: 291_522,
    art: "99898aaa8455735c73b88b2898606b97f8864769e56a9c7a5f08a6aa5bf979b0bd5871b2786ef7bb896ca268759858a98369a79a9ba995552a8778a876e78649408b23644629a94c" },
  { id: "M5", name: "Daniel", desc: "Warm and soft-spoken; calm, natural storytelling.", bytes: 291_469,
    art: "53e75b9b8166905a6b287937fc360a82f87808baf7aa4dca4518baa979f9a6757d6f494607fde9bb9c9f576668dcb75761a9a89a88d761a52f5440dbb699c7ac625a95705b3fa638" },
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
