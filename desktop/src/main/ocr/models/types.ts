/**
 * What the app needs to know about an OCR model — the shape, not the list.
 *
 * One file per model lives beside this one. Adding a model is writing that
 * file and naming it in `index.ts`; removing one from the UI is setting
 * `enabled: false` in it, which keeps the entry (and everything it records
 * about how the model actually behaved) instead of deleting the knowledge
 * along with the code.
 */

/** Weight format. The names are transformers.js dtypes. */
export type OcrDtype = "q4" | "q8" | "fp16" | "fp32";

/** Where the compute happens. "auto" prefers the GPU and falls back. */
export type OcrDevice = "auto" | "webgpu" | "cpu";

/**
 * Which runtime reads the model.
 *
 * "transformers" is @huggingface/transformers doing the work — the normal
 * case, and what a new model should use if the library supports it.
 * "paddle" is our own assembly of three graphs in ocr/paddle, written
 * because no library loads PaddleOCR-VL.
 */
export type OcrEngine = "transformers" | "paddle";

export interface OcrVariant {
  dtype: OcrDtype;
  /** Total size of the weight files, for the UI to state before downloading. */
  bytes: number;
  /**
   * Devices this variant is known to produce CORRECT output on, best first.
   *
   * "Known" is the operative word: q4f16 renders a page as a wall of "!" on
   * both backends here, and PaddleOCR-VL is faster on the CPU than on the
   * iGPU. Both facts were measured, and neither is guessable.
   */
  devices: Exclude<OcrDevice, "auto">[];
  note: string;
}

export interface OcrModelInfo {
  id: string;
  /** Off means the app behaves as though it does not exist. */
  enabled: boolean;
  engine: OcrEngine;
  /** HuggingFace repo the weights come from. */
  repo: string;
  label: string;
  note: string;
  languages: string;
  /**
   * The ONNX components transformers.js loads for this architecture. Each is
   * one `onnx/<component>_<dtype>.onnx` file, sometimes with a sidecar
   * `.onnx_data` for the weights that do not fit the protobuf limit.
   *
   * The paddle engine ignores this — its graphs are named differently, and
   * `variantFiles` knows that.
   */
  components: string[];
  /** What to ask it for a whole page. Per-block prompts live in smart.ts. */
  prompt: string;
  /**
   * Seconds a typical page takes, MEASURED — not from a paper.
   *
   * The settings page shows this instead of prose: "725 MB · ~44s a page"
   * tells somebody choosing a model more than three sentences about
   * architectures, and it is the number they will feel.
   */
  secondsPerPage?: number;
  /** One short line for the settings page. Everything else lives in this
   * file's comment, where it belongs — the UI is not documentation. */
  short: string;
  variants: OcrVariant[];
}
