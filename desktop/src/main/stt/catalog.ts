/**
 * The on-device speech models the app can install, and where their files come
 * from.
 *
 * Whisper-in-the-renderer (transformers.js, WASM) is free and offline, but on
 * Russian it is the weak end of the range: `whisper-base` mangles ordinary
 * dictation and `whisper-small` is nearly a gigabyte for a result that is
 * still worse than what Sber's GigaAM does at a fifth of the compute. GigaAM
 * is a Conformer trained on Russian (v3: 700k hours of pretraining), MIT
 * licensed, and — through sherpa-onnx's NeMo runtime — a native module rather
 * than WASM: measured here, 11 s of speech decoded in 0.39 s on CPU.
 *
 * The `e2e` variants write punctuation and capitals themselves, which is the
 * difference between dictating a sentence and dictating a transcript.
 *
 * Everything is int8: the fp32 encoders are ~900 MB for an accuracy
 * difference nobody dictating a chat message will hear.
 *
 * This file is pure data plus the arithmetic over it — no filesystem, no
 * network — so the catalogue can be checked without downloading a gigabyte.
 */

export type SttModelKind = "transducer" | "ctc";

export interface SttModelFile {
  /** Path inside the repo; the basename is what it is saved as. */
  path: string;
  /** Which slot the recognizer expects it in. */
  role: "encoder" | "decoder" | "joiner" | "model" | "tokens";
  /** Exact size, as published — a byte off means the download is not the file. */
  bytes: number;
  /**
   * What HuggingFace publishes as the file's sha256 (`lfs.oid`).
   *
   * Not paranoia: the first version of the downloader produced a file of
   * exactly the right SIZE with the wrong BYTES, and a corrupt 225 MB ONNX
   * does not fail politely — it takes the recognizer process down with a C++
   * exception and no message. Small non-LFS files have no published hash;
   * their size is the only check available.
   */
  sha256?: string;
}

export interface SttModelInfo {
  id: string;
  label: string;
  /** One line, shown under the name in the mic panel. */
  note: string;
  kind: SttModelKind;
  /** HuggingFace repo the files are fetched from. */
  repo: string;
  files: SttModelFile[];
  /** Languages it is actually good at, for the panel. */
  languages: string;
  /** Writes its own punctuation and capitals. */
  punctuation: boolean;
}

/**
 * WHY EVERY REPO BELOW SAYS `iaa2005`.
 *
 * These are mirrors, and the originals are credited in each `note` and in
 * each mirror's own card. The app used to fetch its models from six
 * different accounts, any one of which can rename, gate or delete a repo
 * — at which point a user who did nothing wrong gets a 404 in the middle
 * of an install. The mirrors hold exactly the files listed here, with the
 * same sha256s, under the same licences.
 *
 * Upstream for the four below: csukuangfj's sherpa-onnx conversions and
 * fussraider's GigaAM-Multilingual, all of GigaAM by Sber's GigaChat team
 * (MIT). Use theirs, not this copy, if you are reading this outside the
 * app.
 */
export const STT_MODELS: SttModelInfo[] = [
  {
    id: "gigaam-v3-rnnt-punct",
    label: "GigaAM v3 RNN-T + punctuation",
    note: "Best Russian quality, writes punctuation itself. Handles Russian mixed with English terms.",
    kind: "transducer",
    repo: "iaa2005/sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16",
    languages: "Русский (+ English words inside Russian speech)",
    punctuation: true,
    files: [
      {
        path: "encoder.int8.onnx",
        role: "encoder",
        bytes: 224_570_820,
        sha256: "369f35a71bf288d3b8e0391fabd8dba5f2314088d440bca474056b7b4b6e66bf",
      },
      {
        path: "decoder.onnx",
        role: "decoder",
        bytes: 4_600_132,
        sha256: "38fc7475443ea2a26f63211ca350f73ac50fff824ab7a3876ee2bd610c53bbc4",
      },
      {
        path: "joiner.onnx",
        role: "joiner",
        bytes: 2_712_896,
        sha256: "602ff7017a93311aad34df1437c8d7f49911353c13d6eae7a6ee7b041339465c",
      },
      { path: "tokens.txt", role: "tokens", bytes: 13_354 },
    ],
  },
  {
    id: "gigaam-v3-ctc-punct",
    label: "GigaAM v3 CTC + punctuation",
    note: "Same training, a simpler decoder: faster, one file, a shade less accurate.",
    kind: "ctc",
    repo: "iaa2005/sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16",
    languages: "Русский (+ English words inside Russian speech)",
    punctuation: true,
    files: [
      {
        path: "model.int8.onnx",
        role: "model",
        bytes: 224_893_661,
        sha256: "d5fea8df94263c285e54b21e5774b707c707192d3bdbeffd7b1eb07fb6743b35",
      },
      { path: "tokens.txt", role: "tokens", bytes: 13_354 },
    ],
  },
  {
    id: "gigaam-multilingual-large-ctc",
    label: "GigaAM Multilingual CTC — large",
    note: "The 600M version: clearly better English, ~2.5× slower and a much bigger download.",
    kind: "ctc",
    repo: "iaa2005/GigaAM-Multilingual-sherpa-onnx-ctc",
    languages: "70+ (ru, en, kk, ky, uz…)",
    punctuation: false,
    files: [
      {
        path: "large/model.int8.onnx",
        role: "model",
        bytes: 591_645_642,
        sha256: "6b6f195026b0f90721cd4593c664becf009a71131550b664eec71446ec351c81",
      },
      { path: "large/tokens.txt", role: "tokens", bytes: 391 },
    ],
  },
  {
    id: "gigaam-multilingual-ctc",
    label: "GigaAM Multilingual CTC",
    note: "70+ languages including English. No punctuation — it writes plain lowercase text.",
    kind: "ctc",
    repo: "iaa2005/GigaAM-Multilingual-sherpa-onnx-ctc",
    languages: "70+ (ru, en, kk, ky, uz…)",
    punctuation: false,
    files: [
      {
        path: "model.int8.onnx",
        role: "model",
        bytes: 224_762_524,
        sha256: "2d94f93ffd4ef58e7899c9de885c25bbbc8c9f1073618868d118a674450ba5f7",
      },
      { path: "tokens.txt", role: "tokens", bytes: 391 },
    ],
  },
];

export const DEFAULT_STT_MODEL = STT_MODELS[0].id;

export function sttModel(id: string): SttModelInfo | undefined {
  return STT_MODELS.find((m) => m.id === id);
}

/** Total download, in bytes. */
export function modelBytes(m: SttModelInfo): number {
  return m.files.reduce((n, f) => n + f.bytes, 0);
}

/** "232 MB" — the number a user decides on before clicking Download. */
export function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)} MB`;
  if (n >= 1000) return `${Math.round(n / 1000)} KB`;
  return `${n} B`;
}

/** Where a file is fetched from. `resolve` is the URL that serves bytes. */
export function fileUrl(m: SttModelInfo, f: SttModelFile): string {
  return `https://huggingface.co/${m.repo}/resolve/main/${f.path}`;
}

/** The name a file is saved under — the repo path's basename, no directories. */
export function fileName(f: SttModelFile): string {
  return f.path.split("/").pop() as string;
}

/**
 * The model half of a sherpa `OfflineRecognizer` config.
 *
 * Kept here, next to the catalogue that decides which files a model has, so
 * the two cannot drift: a transducer needs three networks by name, a CTC pack
 * is one file, and putting the tokens file in the model slot produces an ONNX
 * error a hundred lines away from the mistake.
 */
export function sherpaModelConfig(
  kind: SttModelKind,
  files: Record<string, string>,
): Record<string, unknown> {
  if (kind === "transducer") {
    return {
      transducer: {
        encoder: files.encoder,
        decoder: files.decoder,
        joiner: files.joiner,
      },
      modelType: "nemo_transducer",
    };
  }
  // sherpa reads the NeMo/GigaAM specifics out of the ONNX metadata the export
  // script embedded, so one entry covers every CTC pack.
  return { nemoCtc: { model: files.model } };
}

/**
 * What is wrong with a file that was just downloaded, or null when nothing is.
 *
 * Worth a named function because the failure it catches is invisible: the
 * first downloader here produced a file of exactly the right SIZE with the
 * wrong BYTES, and a corrupt 225 MB ONNX does not report a parse error — it
 * takes the recognizer process down with a C++ exception and no message.
 */
export function downloadProblem(
  f: SttModelFile,
  digest: string,
  bytes: number,
): string | null {
  if (f.sha256 && digest !== f.sha256)
    return `${fileName(f)} arrived corrupt (checksum mismatch) — try again`;
  if (bytes !== f.bytes)
    return `${fileName(f)}: expected ${f.bytes} bytes, got ${bytes}`;
  return null;
}
