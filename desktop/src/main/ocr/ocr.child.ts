/**
 * The OCR model, in a process of its own.
 *
 * Same reasoning as the speech recognizer next door: loading is hundreds of
 * megabytes off disk and generation is a minutes-long loop of native calls,
 * so in main every IPC channel in the app would stall while a PDF is read.
 * In a child it costs one scan when it crashes, and the model stays warm
 * between pages — the second page is generation only.
 *
 * Device choice is decided HERE rather than by settings alone, because the
 * only honest test of a GPU backend is running on it: on the development
 * machine the DirectML provider takes the Arc iGPU down with a device-hung
 * error, while WebGPU on the same hardware is three times faster than the
 * CPU. So "auto" means try the GPU, and fall back to the CPU on the first
 * failure rather than failing the user's scan.
 *
 * One page at a time, deliberately. Two concurrent generations on a shared
 * iGPU do not go twice as fast; they go slower and one of them runs out of
 * memory.
 */

import {
  AutoModelForImageTextToText,
  AutoProcessor,
  env,
  InterruptableStoppingCriteria,
  RawImage,
  TextStreamer,
} from "@huggingface/transformers";

interface LoadRequest {
  type: "load";
  id: number;
  modelsDir: string;
  repo: string;
  dtype: string;
  components: string[];
  device: "auto" | "webgpu" | "cpu";
}

interface ScanRequest {
  type: "scan";
  id: number;
  /** Absolute path of a page image, already rendered by the caller. */
  imagePath: string;
  prompt: string;
  maxTokens: number;
}

interface CancelRequest {
  type: "cancel";
}

type Request = LoadRequest | ScanRequest | CancelRequest;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loaded = { processor: any; model: any; device: string };

let loaded: Loaded | null = null;
let loadedKey = "";
let stopper: InterruptableStoppingCriteria | null = null;

function send(msg: unknown): void {
  process.send?.(msg);
}

async function loadOn(
  req: LoadRequest,
  device: "webgpu" | "cpu",
): Promise<Loaded> {
  env.localModelPath = req.modelsDir;
  // Everything was downloaded by the installer, with checksums. A silent
  // reach for the network here is how a "local" feature becomes one that
  // fails on a plane.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;

  const dtype: Record<string, string> = {};
  for (const c of req.components) dtype[c] = req.dtype;

  const processor = await AutoProcessor.from_pretrained(req.repo);
  const model = await AutoModelForImageTextToText.from_pretrained(req.repo, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dtype: dtype as any,
    device,
  });
  return { processor, model, device };
}

async function load(req: LoadRequest): Promise<void> {
  const key = `${req.repo}:${req.dtype}:${req.device}`;
  if (loaded && loadedKey === key) {
    send({ id: req.id, type: "loaded", device: loaded.device });
    return;
  }
  loaded = null;
  loadedKey = "";

  const order: ("webgpu" | "cpu")[] =
    req.device === "auto" ? ["webgpu", "cpu"] : [req.device];
  let lastError = "";
  for (const device of order) {
    try {
      loaded = await loadOn(req, device);
      loadedKey = key;
      send({ id: req.id, type: "loaded", device });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      send({ type: "note", text: `${device} unavailable: ${lastError}` });
    }
  }
  send({ id: req.id, type: "error", error: lastError || "could not load model" });
}

async function scan(req: ScanRequest): Promise<void> {
  if (!loaded) {
    send({ id: req.id, type: "error", error: "No model loaded" });
    return;
  }
  const { processor, model } = loaded;
  try {
    const image = await RawImage.read(req.imagePath);
    const prompt = processor.apply_chat_template(
      [{ role: "user", content: [{ type: "image" }, { type: "text", text: req.prompt }] }],
      { add_generation_prompt: true },
    );
    // Pixtral's processor — this vision tower comes from Mistral — takes the
    // IMAGE first. Handing it the text first fails deep inside preprocessing
    // with "undefined is not iterable", which says nothing about the cause.
    const inputs = await processor(image, prompt);

    let tokens = 0;
    const streamer = new TextStreamer(processor.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => {
        tokens++;
        send({ id: req.id, type: "delta", text, tokens });
      },
    });

    stopper = new InterruptableStoppingCriteria();
    const out = await model.generate({
      ...inputs,
      max_new_tokens: req.maxTokens,
      do_sample: false,
      streamer,
      stopping_criteria: stopper,
    });
    stopper = null;

    const generated = out.slice(null, [inputs.input_ids.dims.at(-1), null]);
    const [text] = processor.batch_decode(generated, { skip_special_tokens: true });
    send({ id: req.id, type: "done", text, tokens: generated.dims.at(-1) });
  } catch (err) {
    stopper = null;
    send({
      id: req.id,
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

process.on("message", (msg: Request) => {
  if (msg.type === "load") void load(msg);
  else if (msg.type === "scan") void scan(msg);
  else if (msg.type === "cancel") stopper?.interrupt();
});

// A parent that goes away takes this with it — a stranded child holding a
// gigabyte of weights is not something the user can see or kill.
process.on("disconnect", () => process.exit(0));
