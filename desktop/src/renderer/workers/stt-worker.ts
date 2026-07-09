/**
 * Local speech-to-text worker — Whisper via @huggingface/transformers (ONNX).
 *
 * Runs entirely on-device: the model is downloaded from the HuggingFace hub on
 * first use (then cached by the browser Cache API, so later runs work
 * offline) and inference runs in this worker so the UI thread never blocks.
 * Tries WebGPU first, falls back to WASM; if the bundled ONNX wasm assets
 * fail to resolve, retries with the CDN copies.
 *
 * Protocol:
 *   in : { id, audio: Float32Array(16kHz mono), model, language? }
 *   out: { id, type: "progress", progress, loaded, total } // model download,
 *              aggregated across all files (bytes)
 *        { id, type: "status", text }                      // phase changes
 *        { id, type: "result", text }
 *        { id, type: "error", error }
 */

import { pipeline, env } from "@huggingface/transformers";

interface TranscribeRequest {
  id: number;
  audio: Float32Array;
  model: string;
  language?: string;
}

const ctx = self as unknown as {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (e: MessageEvent<TranscribeRequest>) => void,
  ): void;
};

// Models come from the hub, never from a local server path.
try {
  (env as { allowLocalModels?: boolean }).allowLocalModels = false;
} catch {
  /* env shape changed — defaults are fine */
}

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text?: string } | { text?: string }[]>;

let asr: AsrPipeline | null = null;
let loadedModel = "";

function post(msg: Record<string, unknown>): void {
  ctx.postMessage(msg);
}

async function createPipeline(
  id: number,
  model: string,
): Promise<AsrPipeline> {
  // The hub downloads several files in parallel (tokenizer, encoder/decoder
  // ONNX…) and reports per-file percentages — showing those raw makes the
  // number jump around (3 → 50 → 30). Aggregate bytes across every file seen
  // so far and report ONE overall percentage.
  const files = new Map<string, { loaded: number; total: number }>();
  let lastPct = -1;
  const progress_callback = (p: unknown): void => {
    const info = p as {
      status?: string;
      file?: string;
      loaded?: number;
      total?: number;
    };
    if (
      info.status !== "progress" ||
      !info.file ||
      typeof info.loaded !== "number" ||
      typeof info.total !== "number" ||
      info.total <= 0
    ) {
      return;
    }
    files.set(info.file, { loaded: info.loaded, total: info.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    const pct = Math.min(100, Math.floor((loaded / total) * 100));
    if (pct === lastPct) return; // don't spam the UI thread
    lastPct = pct;
    post({ id, type: "progress", progress: pct, loaded, total });
  };
  const attempts: Record<string, unknown>[] = [
    { dtype: "q8", device: "webgpu", progress_callback },
    { dtype: "q8", progress_callback },
  ];
  let lastErr: unknown;
  for (const [i, options] of attempts.entries()) {
    try {
      return (await pipeline(
        "automatic-speech-recognition",
        model,
        options,
      )) as unknown as AsrPipeline;
    } catch (err) {
      lastErr = err;
      if (i === 0) post({ id, type: "status", text: "WebGPU unavailable — using CPU (WASM)" });
      // Bundled wasm assets can fail to resolve under some bundlers — point
      // the ONNX runtime at the CDN copies and let the next attempt retry.
      try {
        const backends = (
          env as {
            backends?: { onnx?: { wasm?: { wasmPaths?: string } } };
          }
        ).backends;
        if (backends?.onnx?.wasm) {
          backends.onnx.wasm.wasmPaths =
            "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/";
        }
      } catch {
        /* best-effort */
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

ctx.addEventListener("message", (e: MessageEvent<TranscribeRequest>) => {
  void (async () => {
    const { id, audio, model, language } = e.data;
    try {
      if (!asr || loadedModel !== model) {
        post({ id, type: "status", text: "Loading model…" });
        asr = await createPipeline(id, model);
        loadedModel = model;
      }
      post({ id, type: "status", text: "Transcribing…" });
      const out = await asr(audio, {
        chunk_length_s: 30,
        ...(language ? { language, task: "transcribe" } : {}),
      });
      const text = Array.isArray(out)
        ? out.map((o) => o.text ?? "").join(" ")
        : (out.text ?? "");
      post({ id, type: "result", text: text.trim() });
    } catch (err) {
      post({
        id,
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});
