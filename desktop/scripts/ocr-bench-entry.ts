/**
 * What the OCR bench needs, in one module.
 *
 * Deliberately NOT the app's engine: the bench compares candidates the app
 * does not have installed and may never ship, on devices the settings do not
 * offer. It loads a model, reads one page, reports what it cost, and throws
 * the model away — the app's engine keeps one model warm, which is right for
 * the app and wrong for a comparison.
 *
 * Weights come from HuggingFace into the bench's own cache, so trying a
 * candidate never disturbs what the user has installed.
 */

import {
  AutoModelForImageTextToText,
  AutoProcessor,
  env,
  RawImage,
} from "@huggingface/transformers";
import { join } from "path";
import { tmpdir } from "os";

export { registerRasteriserIPC, renderPdf, closeRasteriser } from "../src/main/ocr/render.js";

export interface BenchCandidate {
  id: string;
  label: string;
  engine: "transformers";
  repo: string;
  components: string[];
  dtype: string;
  device: string;
  prompt: string;
}

export interface BenchResult {
  text: string;
  tokens: number;
  loadSecs: number;
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loaded: { key: string; processor: any; model: any } | null = null;

export function disposeBench(): void {
  loaded = null;
}

async function load(cand: BenchCandidate): Promise<void> {
  const key = `${cand.repo}:${cand.dtype}:${cand.device}`;
  if (loaded?.key === key) return;
  env.cacheDir = join(tmpdir(), "monet-ocr-bench-cache");
  env.allowRemoteModels = true;
  const dtype: Record<string, string> = {};
  for (const c of cand.components) dtype[c] = cand.dtype;
  const processor = await AutoProcessor.from_pretrained(cand.repo);
  const model = await AutoModelForImageTextToText.from_pretrained(cand.repo, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dtype: dtype as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    device: cand.device as any,
  });
  loaded = { key, processor, model };
}

/** One candidate, one page image. Loading is timed separately: a model that
 * takes a minute to load and a second to run is a different problem from one
 * that loads instantly and grinds. */
export async function benchPage(
  cand: BenchCandidate,
  imagePath: string,
): Promise<BenchResult> {
  const t0 = Date.now();
  await load(cand);
  const loadSecs = (Date.now() - t0) / 1000;
  const { processor, model } = loaded!;

  const image = await RawImage.read(imagePath);
  const prompt = processor.apply_chat_template(
    [{ role: "user", content: [{ type: "image" }, { type: "text", text: cand.prompt }] }],
    { add_generation_prompt: true },
  );
  // Processors disagree on argument order and say so unhelpfully — Pixtral
  // (LightOnOCR) takes the image first, Idefics3 (SmolDocling) the text, and
  // the wrong one dies deep inside preprocessing with "undefined is not
  // iterable". Try both rather than encoding a table of which is which.
  let inputs;
  try {
    inputs = await processor(image, prompt);
  } catch {
    inputs = await processor(prompt, image);
  }
  const out = await model.generate({
    ...inputs,
    max_new_tokens: 2048,
    do_sample: false,
  });
  const generated = out.slice(null, [inputs.input_ids.dims.at(-1), null]);
  const [text] = processor.batch_decode(generated, { skip_special_tokens: true });
  return { text, tokens: generated.dims.at(-1), loadSecs };
}
