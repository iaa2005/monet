/**
 * The Whisper models the browser-side recogniser can load.
 *
 * One list, because there were three: the mic panel, the settings page and
 * the main process each spelled the same three repo ids out, and moving
 * them to a mirror meant finding nine string literals in three files. A
 * tenth one somewhere would have kept fetching from an account the app no
 * longer depends on, and nothing would have said so.
 *
 * These are MIRRORS of Xenova's ONNX conversions of OpenAI Whisper, kept
 * on one account so a rename upstream cannot break an install. Apache 2.0,
 * as the originals are. The originals are at `Xenova/whisper-*`, and are
 * what you should use if you are not this app.
 *
 * Whisper is the weak tier here — see stt/catalog.ts for why GigaAM is the
 * default on Russian — so this exists mostly for languages GigaAM does not
 * cover well.
 */

export interface WhisperTier {
  /** HuggingFace repo id, loaded by transformers.js in the renderer. */
  id: string;
  /** What the settings page shows. */
  label: string;
}

export const WHISPER_TIERS: WhisperTier[] = [
  { id: "iaa2005/whisper-tiny", label: "Fast (~147 MB)" },
  { id: "iaa2005/whisper-base", label: "Balanced (~280 MB)" },
  { id: "iaa2005/whisper-small", label: "Accurate (~926 MB)" },
];

/** The middle one: the best of these that is not a gigabyte. */
export const DEFAULT_WHISPER = WHISPER_TIERS[1].id;
