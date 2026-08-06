/**
 * PaddleOCR-VL, assembled by hand.
 *
 * @huggingface/transformers cannot load this model: it knows the decoder
 * family (`ernie4_5`) but not the `paddleocr_vl` wrapper, and the processor
 * that goes with it is Python. Everything the library would have done is
 * therefore written out in this folder — preprocess.ts turns a picture into
 * patches, generate.ts steps the three graphs, and this puts the two
 * together and owns the session lifetime.
 *
 * The tokenizer is the one part still borrowed: `AutoTokenizer` reads a
 * `tokenizer.json` without caring which model it belongs to, and rewriting
 * a BPE tokenizer to avoid a dependency that already works would be silly.
 *
 * Why bother at all, given LightOnOCR works: this model is markedly better
 * on tables, and the user has it in production elsewhere. It is a second
 * opinion the bench can measure rather than a replacement.
 */

import { readFileSync } from "fs";
import { ort as ortModule } from "../ort.js";
import { join } from "path";
import { AutoTokenizer, RawImage } from "@huggingface/transformers";
import { smartResize, patchify, MERGE_SIZE, type PatchedImage } from "./preprocess.js";
import { generate, type PaddleConfig, type PaddleSessions } from "./generate.js";

export const PADDLE_REPO = "onnx-community/PaddleOCR-VL-1.5-ONNX";

/** The graphs, and the file each one is quantised into. */
export const PADDLE_FILES = {
  vision: "onnx/vision_encoder_q4.onnx",
  decoder: "onnx/decoder_q4.onnx",
  // Not quantised on purpose: an embedding table is pure lookup, and the
  // repo publishes no q4 of it anyway.
  embedding: "onnx/embedding.onnx",
  embeddingData: "onnx/embedding.onnx.data",
} as const;

export const PADDLE_CONFIG_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "chat_template.jinja",
];

/**
 * How many patches one page may become.
 *
 * The tower has no fixed input, so this is the knob that trades detail for
 * time. 2048 merged tokens is roughly an A4 at 150 DPI — enough for
 * subscripts, and the point past which the decoder's context is doing more
 * work than the page deserves.
 */
const TOKEN_LIMIT = 8192;

interface Loaded {
  sessions: PaddleSessions;
  cfg: PaddleConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tokenizer: any;
  device: string;
}

let loaded: Loaded | null = null;
let loadedKey = "";

function readConfig(dir: string): PaddleConfig {
  const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as {
    hidden_size: number;
    num_hidden_layers: number;
    num_key_value_heads: number;
    head_dim: number;
    image_token_id: number;
    eos_token_id: number;
  };
  return {
    hiddenSize: raw.hidden_size,
    numLayers: raw.num_hidden_layers,
    numKeyValueHeads: raw.num_key_value_heads,
    headDim: raw.head_dim,
    imageTokenId: raw.image_token_id,
    eosTokenId: raw.eos_token_id,
  };
}

export async function loadPaddle(
  modelDir: string,
  device: "webgpu" | "cpu",
): Promise<Loaded> {
  const key = `${modelDir}:${device}`;
  if (loaded && loadedKey === key) return loaded;
  const ort = ortModule();
  const providers = [device === "webgpu" ? "webgpu" : "cpu"];
  const open = (file: string): Promise<unknown> =>
    ort.InferenceSession.create(join(modelDir, file), {
      executionProviders: providers,
    });

  // A backend that cannot run these graphs must not fail the scan: the CPU
  // is slower but always there, which is the same bargain the other engine
  // makes.
  const openAll = (): Promise<unknown[]> => Promise.all([
    // PADDLE_VISION swaps the tower's quantisation for a comparison run;
    // the catalogue decides what ships.
    open(process.env["PADDLE_VISION"] || PADDLE_FILES.vision),
    open(process.env["PADDLE_DECODER"] || PADDLE_FILES.decoder),
    open(PADDLE_FILES.embedding),
  ]);

  let sessions: unknown[];
  let used = device;
  try {
    sessions = await openAll();
  } catch (err) {
    if (device === "cpu") throw err;
    used = "cpu";
    providers[0] = "cpu";
    sessions = await openAll();
  }
  const [vision, decoder, embedding] = sessions;

  loaded = {
    sessions: { vision, decoder, embedding } as PaddleSessions,
    cfg: readConfig(modelDir),
    tokenizer: await AutoTokenizer.from_pretrained(modelDir, {
      local_files_only: true,
    }),
    device: used,
  };
  loadedKey = key;
  return loaded;
}

export function disposePaddle(): void {
  loaded = null;
  loadedKey = "";
}

/**
 * The prompt, with the picture's placeholder expanded.
 *
 * The chat template writes ONE `<|IMAGE_PLACEHOLDER|>`; the Python
 * processor then repeats it once per merged patch. Doing that here rather
 * than in the template keeps the count in the same file as the patching
 * that decides it.
 */
export function buildPrompt(text: string, imageTokens: number): string {
  const placeholder = "<|IMAGE_PLACEHOLDER|>";
  return (
    "<|begin_of_sentence|>User: <|IMAGE_START|>" +
    placeholder.repeat(imageTokens) +
    "<|IMAGE_END|>" +
    text +
    "\nAssistant:\n"
  );
}

/** A picture, ready for the tower. */
export async function prepareImage(imagePath: string): Promise<PatchedImage> {
  const image = await RawImage.read(imagePath);
  const fit = smartResize(image.width, image.height);
  const rgb = (await image.resize(fit.width, fit.height)).rgb();
  return patchify(rgb.data as Uint8Array, fit.width, fit.height);
}

export interface PaddleScanResult {
  text: string;
  tokens: number;
  device: string;
}

export async function scanWithPaddle(
  modelDir: string,
  device: "webgpu" | "cpu",
  imagePath: string,
  prompt: string,
  maxTokens: number,
  onToken?: (text: string, tokens: number) => void,
): Promise<PaddleScanResult> {
  const ort = ortModule();
  const state = await loadPaddle(modelDir, device);
  const image = await prepareImage(imagePath);

  const full = buildPrompt(prompt, image.numImageTokens);
  const encoded = state.tokenizer.encode(full, { add_special_tokens: false });
  const promptIds: number[] = Array.from(encoded as number[]);

  const produced: number[] = [];
  const ids = await generate(ort, state.sessions, state.cfg, promptIds, image, {
    maxTokens,
    onToken: (id, step) => {
      produced.push(id);
      // Decoding the tail each time is cheap next to a decoder step, and it
      // is what lets a caller show the page filling in.
      if (onToken) {
        const piece = state.tokenizer.decode([id], {
          skip_special_tokens: true,
        }) as string;
        onToken(piece, step + 1);
      }
    },
  });

  return {
    text: state.tokenizer.decode(ids, { skip_special_tokens: true }) as string,
    tokens: ids.length,
    device: state.device,
  };
}

/** Merged patches per side, for callers that report what it read. */
export function mergedGrid(image: PatchedImage): { rows: number; cols: number } {
  return {
    rows: image.gridTHW[1] / MERGE_SIZE,
    cols: image.gridTHW[2] / MERGE_SIZE,
  };
}
