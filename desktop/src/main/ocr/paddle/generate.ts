/**
 * The decode loop @huggingface/transformers would have written for us.
 *
 * PaddleOCR-VL is three graphs — a vision tower, an embedding table and a
 * decoder — and nothing in the library knows how to put them together for
 * this architecture. So: run the tower on the patches, look up embeddings
 * for the prompt tokens, splice the image embeddings in where the image
 * placeholder token sits, then step the decoder one token at a time,
 * carrying its key/value cache forward.
 *
 * The fiddly parts, in order of how quietly they fail:
 *
 *   - the KV cache is named per layer (`past_key_values.N.key`), and every
 *     one of them must be fed on the FIRST step too, empty, or the graph
 *     refuses to run;
 *   - the decoder emits `present.N.*`, which become the next step's `past`;
 *   - grouped-query attention means the cache has fewer heads than the
 *     attention does — 2 against 16 here — so the empty tensors must be
 *     shaped from the config, not guessed from the head count;
 *   - position ids are 3-D (mrope: time, height, width). For a single
 *     image the three rows are identical, which is why a 1-D guess appears
 *     to work for a while and then drifts on longer pages.
 */

import type { PatchedImage } from "./preprocess.js";

/** What the model's config.json says about its own shape. */
export interface PaddleConfig {
  hiddenSize: number;
  numLayers: number;
  numKeyValueHeads: number;
  headDim: number;
  imageTokenId: number;
  eosTokenId: number;
}

// The ONNX runtime's types are structural and vary by build; this module
// talks to it through one narrow surface rather than importing them.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Ort {
  Tensor: new (type: string, data: unknown, dims: number[]) => any;
  InferenceSession: {
    create: (path: string, opts?: unknown) => Promise<any>;
  };
}

export interface PaddleSessions {
  vision: any;
  embedding: any;
  decoder: any;
}

/** An empty cache entry: [batch, kvHeads, 0, headDim]. */
function emptyCache(ort: Ort, cfg: PaddleConfig): any {
  return new ort.Tensor(
    "float32",
    new Float32Array(0),
    [1, cfg.numKeyValueHeads, 0, cfg.headDim],
  );
}

/**
 * Text embeddings for a run of token ids.
 *
 * The embedding table is its own graph because it is 400 MB of lookup and
 * nothing else — quantising it costs accuracy for weights that are only
 * ever indexed.
 */
async function embed(
  ort: Ort,
  sessions: PaddleSessions,
  ids: number[],
): Promise<{ data: Float32Array; length: number }> {
  const input = new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [
    1,
    ids.length,
  ]);
  const name = sessions.embedding.inputNames[0];
  const out = await sessions.embedding.run({ [name]: input });
  const key = sessions.embedding.outputNames[0];
  return { data: out[key].data as Float32Array, length: ids.length };
}

/**
 * Put the picture where the placeholder is.
 *
 * The prompt contains one image token per merged patch; the tower produces
 * exactly that many vectors, and they replace the placeholder embeddings in
 * place. A mismatch here is the classic silent failure — the model reads a
 * page that is half text embeddings — so it is checked rather than trusted.
 */
export function spliceImage(
  textEmbeds: Float32Array,
  ids: number[],
  imageEmbeds: Float32Array,
  cfg: PaddleConfig,
): Float32Array {
  const slots: number[] = [];
  ids.forEach((id, i) => {
    if (id === cfg.imageTokenId) slots.push(i);
  });
  const have = imageEmbeds.length / cfg.hiddenSize;
  if (slots.length !== have)
    throw new Error(
      `the prompt has ${slots.length} image slots but the vision tower produced ${have} vectors`,
    );
  const out = new Float32Array(textEmbeds);
  slots.forEach((slot, k) => {
    out.set(
      imageEmbeds.subarray(k * cfg.hiddenSize, (k + 1) * cfg.hiddenSize),
      slot * cfg.hiddenSize,
    );
  });
  return out;
}

/**
 * Position ids for mrope, as [3, 1, length].
 *
 * The three sections (time, height, width) are what the rope split in the
 * config refers to. For one still image the grid is walked in reading order
 * and the text around it advances all three together, which is what the
 * reference implementation reduces to when there is a single frame.
 */
export function positionIds(
  ids: number[],
  cfg: PaddleConfig,
  grid: [number, number, number],
  mergeSize: number,
): BigInt64Array {
  const len = ids.length;
  const t = new BigInt64Array(len);
  const h = new BigInt64Array(len);
  const w = new BigInt64Array(len);
  const rows = grid[1] / mergeSize;
  const cols = grid[2] / mergeSize;

  let cursor = 0;
  let seen = 0;
  for (let i = 0; i < len; i++) {
    if (ids[i] === cfg.imageTokenId) {
      // Inside the picture, height and width walk the grid while time
      // stands still; the whole image occupies one step of the text clock.
      const row = Math.floor(seen / cols);
      const col = seen % cols;
      t[i] = BigInt(cursor);
      h[i] = BigInt(cursor + row);
      w[i] = BigInt(cursor + col);
      seen++;
      if (seen === rows * cols) cursor += Math.max(rows, cols);
      continue;
    }
    t[i] = BigInt(cursor);
    h[i] = BigInt(cursor);
    w[i] = BigInt(cursor);
    cursor++;
  }

  const out = new BigInt64Array(3 * len);
  out.set(t, 0);
  out.set(h, len);
  out.set(w, 2 * len);
  return out;
}

export interface GenerateOptions {
  maxTokens: number;
  /** Called with each new token id as it is produced. */
  onToken?: (id: number, step: number) => void;
  /** Checked between steps; true stops the generation where it is. */
  shouldStop?: () => boolean;
}

/**
 * Greedy decode. OCR is transcription, not writing — there is a right
 * answer on the page, and sampling can only move away from it.
 */
export async function generate(
  ort: Ort,
  sessions: PaddleSessions,
  cfg: PaddleConfig,
  promptIds: number[],
  image: PatchedImage | null,
  opts: GenerateOptions,
): Promise<number[]> {
  // 1. The picture, if there is one.
  let imageEmbeds: Float32Array | null = null;
  if (image) {
    const visionFeeds: Record<string, any> = {};
    for (const name of sessions.vision.inputNames as string[]) {
      if (name.includes("pixel"))
        // [1, patches, 3, 14, 14] — the graph declares rank 5, one patch per
        // row with its channels intact, which is exactly how patchify lays
        // the buffer out.
        visionFeeds[name] = new ort.Tensor("float32", image.pixelValues, [
          1,
          image.numPatches,
          3,
          14,
          14,
        ]);
      else if (name.includes("grid"))
        visionFeeds[name] = new ort.Tensor(
          "int64",
          BigInt64Array.from(image.gridTHW.map(BigInt)),
          [1, 3],
        );
    }
    const visionOut = await sessions.vision.run(visionFeeds);
    imageEmbeds = visionOut[sessions.vision.outputNames[0]].data as Float32Array;
  }

  // 2. The prompt, as embeddings with the picture spliced in.
  const text = await embed(ort, sessions, promptIds);
  const inputs = imageEmbeds
    ? spliceImage(text.data, promptIds, imageEmbeds, cfg)
    : text.data;

  // 3. Step the decoder.
  const past: Record<string, any> = {};
  for (let l = 0; l < cfg.numLayers; l++) {
    past[`past_key_values.${l}.key`] = emptyCache(ort, cfg);
    past[`past_key_values.${l}.value`] = emptyCache(ort, cfg);
  }

  const generated: number[] = [];
  let embeds = inputs;
  let length = promptIds.length;
  let offset = 0;
  const idsSoFar = [...promptIds];

  for (let step = 0; step < opts.maxTokens; step++) {
    if (opts.shouldStop?.()) break;

    const feeds: Record<string, any> = {
      inputs_embeds: new ort.Tensor("float32", embeds, [
        1,
        length,
        cfg.hiddenSize,
      ]),
      attention_mask: new ort.Tensor(
        "int64",
        BigInt64Array.from(
          new Array<bigint>(offset + length).fill(1n),
        ),
        [1, offset + length],
      ),
      ...past,
    };
    if ((sessions.decoder.inputNames as string[]).includes("position_ids")) {
      const pos =
        step === 0
          ? positionIds(idsSoFar, cfg, image?.gridTHW ?? [1, 0, 0], 2)
          : (() => {
              // After the prompt every step is one token further along all
              // three axes.
              const at = BigInt(offset);
              return BigInt64Array.from([at, at, at]);
            })();
      feeds.position_ids = new ort.Tensor(
        "int64",
        pos,
        step === 0 ? [3, 1, length] : [3, 1, 1],
      );
    }

    const out = await sessions.decoder.run(feeds);
    const logitsTensor = out[
      (sessions.decoder.outputNames as string[]).find((n) =>
        n.includes("logits"),
      ) ?? "logits"
    ];
    const logits = logitsTensor.data as Float32Array;
    const vocab = logitsTensor.dims[logitsTensor.dims.length - 1] as number;
    // The last position's row is the prediction for the next token.
    const rowStart = logits.length - vocab;
    let best = 0;
    let bestValue = -Infinity;
    for (let v = 0; v < vocab; v++) {
      const value = logits[rowStart + v];
      if (value > bestValue) {
        bestValue = value;
        best = v;
      }
    }

    if (best === cfg.eosTokenId) break;
    generated.push(best);
    idsSoFar.push(best);
    opts.onToken?.(best, step);

    for (const name of sessions.decoder.outputNames as string[]) {
      if (name.startsWith("present."))
        past[name.replace("present.", "past_key_values.")] = out[name];
    }

    const next = await embed(ort, sessions, [best]);
    embeds = next.data;
    offset += length;
    length = 1;
  }

  return generated;
}
