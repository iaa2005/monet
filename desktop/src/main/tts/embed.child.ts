/**
 * The speaker embedder, in a process of its own.
 *
 * Same reasoning as the recogniser and the synthesiser next door: a native
 * module loaded inside main takes the whole app down, and a 29 MB ONNX session
 * plus a blocking C call has no business on main's event loop. Kept alive
 * between calls — fitting a voice runs this sixty-odd times in a row.
 *
 * What it computes is a speaker embedding: a vector that says WHO is speaking
 * and (mostly) not what they said. Two of them compared by cosine is the whole
 * objective the voice fit optimises.
 *
 * Audio arrives as a plain array (Electron forbids external buffers across
 * IPC) at whatever rate it was captured or synthesised at; the model wants
 * 16 kHz, so anything else is resampled here rather than at the call sites.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);

interface EmbedRequest {
  id: number;
  type: "embed";
  model: string;
  samples: number[];
  sampleRate: number;
}

interface Extractor {
  dim: number;
  createStream(): Stream;
  compute(s: Stream, external?: boolean): Float32Array;
}
interface Stream {
  acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void;
}
interface Resampler {
  resample(s: Float32Array): Float32Array;
  flush(s: Float32Array): Float32Array;
}

const TARGET_RATE = 16_000;

let extractor: Extractor | null = null;
let loaded = "";
let resampler: Resampler | null = null;
let resamplerFrom = 0;

interface Sherpa {
  SpeakerEmbeddingExtractor: new (c: unknown) => Extractor;
  LinearResampler: new (from: number, to: number) => Resampler;
}

function sherpa(): Sherpa {
  return require("sherpa-onnx-node") as Sherpa;
}

function at16k(samples: Float32Array, rate: number): Float32Array {
  if (rate === TARGET_RATE) return samples;
  if (!resampler || resamplerFrom !== rate) {
    resampler = new (sherpa().LinearResampler)(rate, TARGET_RATE);
    resamplerFrom = rate;
  }
  // One shot, flushed: every request is a complete clip, not a stream.
  return resampler.flush(samples);
}

process.on("message", (req: EmbedRequest) => {
  if (req?.type !== "embed") return;
  try {
    if (!extractor || loaded !== req.model) {
      extractor = null;
      extractor = new (sherpa().SpeakerEmbeddingExtractor)({
        model: req.model,
        numThreads: 2,
        provider: "cpu",
        debug: false,
      });
      loaded = req.model;
    }
    const ex = extractor;
    const stream = ex.createStream();
    stream.acceptWaveform({
      sampleRate: TARGET_RATE,
      samples: at16k(Float32Array.from(req.samples), req.sampleRate),
    });
    const embedding = ex.compute(stream, false);
    process.send?.({ id: req.id, type: "result", embedding: Array.from(embedding) });
  } catch (err) {
    extractor = null;
    loaded = "";
    process.send?.({
      id: req.id,
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
