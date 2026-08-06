/**
 * The OCR models the app can install.
 *
 * The problem this solves: a text-only model (DeepSeek, Kimi, most of what
 * people actually run) cannot see. Hand it a scanned page, a PDF full of
 * formulas or a screenshot and it is blind — it will write Python that shells
 * out to some library it hopes exists, and the answer is a guess about a
 * picture nobody looked at. An OCR model IS the eyes, and it belongs to the
 * app rather than to the chat model.
 *
 * Everything here runs IN the app: `onnxruntime-node` with the WebGPU/CPU
 * backends it already ships, driven by `@huggingface/transformers`, which the
 * app already depends on for other on-device work. No Ollama, no Python, no
 * server to start — installing a model is downloading its weights.
 *
 * Measured on the development machine (Core Ultra 7 155H, Arc iGPU, no CUDA),
 * one A4 page of a formula-heavy paper at 150 DPI, LightOnOCR-2 q4, end to
 * end — rasterising, generating, decoding:
 *   - WebGPU (the iGPU): 2.8 minutes a page (5.5 tok/s generating)
 *   - CPU:               ~6 minutes a page (2.0 tok/s)
 * A machine with a discrete GPU is many times faster; those numbers are the
 * floor, not the expectation. They are also why the tool's prompt tells the
 * model to put long documents on a background agent.
 *
 * Weight formats are NOT interchangeable, and getting this wrong does not
 * fail loudly — it produces fluent nonsense. `q4f16` renders a page as a wall
 * of "!" on both CPU and WebGPU here, because the f16 compute path it needs
 * is not honoured; `q4` is correct on both. So each variant carries what it
 * was actually observed to do, and the default is the one that works.
 *
 * Pure data plus arithmetic over it — no filesystem, no network — so the
 * catalogue is checkable without downloading a gigabyte.
 */

/** Weight format. The names are transformers.js dtypes. */
export type OcrDtype = "q4" | "fp16" | "fp32";

/** Where the compute happens. "auto" prefers the GPU and falls back. */
export type OcrDevice = "auto" | "webgpu" | "cpu";

export interface OcrVariant {
  dtype: OcrDtype;
  /** Total size of the weight files, for the UI to state before downloading. */
  bytes: number;
  /** Devices this variant is known to produce CORRECT output on. */
  devices: Exclude<OcrDevice, "auto">[];
  note: string;
}

export interface OcrModelInfo {
  id: string;
  /** HuggingFace repo the weights come from. */
  repo: string;
  label: string;
  note: string;
  languages: string;
  /**
   * The ONNX components transformers.js loads for this architecture. Each is
   * one `onnx/<component>_<dtype>.onnx` file, sometimes with a sidecar
   * `.onnx_data` for the weights that do not fit the protobuf limit.
   */
  components: string[];
  /** What to ask it. OCR models are single-purpose; this is not a chat. */
  prompt: string;
  variants: OcrVariant[];
}

export const OCR_MODELS: OcrModelInfo[] = [
  {
    id: "lightonocr-2-1b",
    repo: "onnx-community/LightOnOCR-2-1B-ONNX",
    label: "LightOnOCR-2 1B",
    note:
      "End-to-end document OCR: a page in, Markdown out, with formulas as LaTeX and tables as tables. A Mistral vision encoder on a Qwen3 decoder, 1B parameters, Apache 2.0.",
    languages: "English, French, German, Spanish, Italian, Dutch, Portuguese, Swedish, Danish, Chinese, Japanese",
    components: ["embed_tokens", "vision_encoder", "decoder_model_merged"],
    prompt: "Convert this page to markdown.",
    variants: [
      {
        dtype: "q4",
        bytes: 725 * 1024 * 1024,
        devices: ["webgpu", "cpu"],
        note: "The default. Correct on both the GPU and the CPU; the only variant measured good on this hardware.",
      },
      {
        dtype: "fp16",
        bytes: 2_100 * 1024 * 1024,
        devices: ["webgpu"],
        note: "Full half precision — three times the download, for a GPU that has the memory for it.",
      },
      {
        dtype: "fp32",
        bytes: 4_100 * 1024 * 1024,
        devices: ["cpu"],
        note: "Reference precision. Slow and large; here only because a CPU with no better option can still run it.",
      },
    ],
  },
];

export function ocrModel(id: string): OcrModelInfo | undefined {
  return OCR_MODELS.find((m) => m.id === id);
}

export function ocrVariant(
  model: OcrModelInfo,
  dtype: OcrDtype,
): OcrVariant | undefined {
  return model.variants.find((v) => v.dtype === dtype);
}

/**
 * The files one variant needs, as repo-relative paths.
 *
 * The `.onnx_data` sidecar is not always there — a component small enough to
 * fit in the protobuf has none — so this returns the CANDIDATES and the
 * installer keeps whichever the repo actually publishes.
 */
export function variantFiles(
  model: OcrModelInfo,
  dtype: OcrDtype,
): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  for (const c of model.components) {
    required.push(`onnx/${c}_${dtype}.onnx`);
    optional.push(`onnx/${c}_${dtype}.onnx_data`);
  }
  return { required, optional };
}

/**
 * The processor/tokenizer files, shared by every variant.
 *
 * transformers.js reads these by name; a missing one fails at load with a
 * 404-shaped error rather than anything about OCR, so they are listed
 * explicitly instead of being fetched on demand from the network.
 */
export const CONFIG_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "processor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "chat_template.jinja",
];

/** Human-readable size, for the UI and for tool output. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
