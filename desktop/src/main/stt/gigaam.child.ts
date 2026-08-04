/**
 * The GigaAM recognizer, in a process of its own.
 *
 * It cannot live in main: building the recognizer reads ~230 MB of ONNX off
 * disk and decoding is a synchronous C call, so every IPC channel in the app
 * would stall while you dictate.
 *
 * A worker_thread was the first attempt and it failed worse than slowly —
 * loading the native module inside one of MAIN's threads killed the whole
 * app, hard, with no exception to catch (the same module, the same file,
 * loads fine in a bare Electron process). In a child process it behaves as it
 * does under plain Node, and a crash costs one dictation instead of the
 * session.
 *
 * The recognizer is kept alive between utterances (the second dictation is
 * then just the decode) and rebuilt when the chosen model changes.
 *
 * Note for anyone extending this: sherpa's own `readWave()` hands back an
 * external ArrayBuffer, and Electron forbids those ("External buffers are not
 * allowed"). Audio therefore arrives as samples from the app, already 16 kHz
 * mono, and nothing here reads audio files.
 */

import { createRequire } from "module";
import { sherpaModelConfig } from "./catalog.js";

const require = createRequire(import.meta.url);

interface TranscribeRequest {
  id: number;
  type: "transcribe";
  modelId: string;
  kind: "transducer" | "ctc";
  /** Absolute paths by role, already verified to exist by the caller. */
  files: Record<string, string>;
  /** 16 kHz mono PCM, as a plain array — it crosses a process boundary. */
  samples: number[];
  sampleRate: number;
  threads: number;
}

interface Recognizer {
  createStream(): Stream;
  decode(s: Stream): void;
  getResult(s: Stream): { text?: string };
}
interface Stream {
  acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void;
}

let recognizer: Recognizer | null = null;
let loaded = "";

function build(req: TranscribeRequest): Recognizer {
  const sherpa = require("sherpa-onnx-node") as {
    OfflineRecognizer: new (config: unknown) => Recognizer;
  };
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      ...sherpaModelConfig(req.kind, req.files),
      tokens: req.files.tokens,
      numThreads: req.threads,
      provider: "cpu",
      debug: false,
    },
  });
}

function send(msg: Record<string, unknown>): void {
  process.send?.(msg);
}

process.on("message", (req: TranscribeRequest) => {
  if (req?.type !== "transcribe") return;
  try {
    const t0 = Date.now();
    let loadMs = 0;
    if (!recognizer || loaded !== req.modelId) {
      recognizer = null; // drop the old sessions before allocating new ones
      recognizer = build(req);
      loaded = req.modelId;
      loadMs = Date.now() - t0;
    }
    const t1 = Date.now();
    const stream = recognizer.createStream();
    stream.acceptWaveform({
      sampleRate: req.sampleRate,
      samples: Float32Array.from(req.samples),
    });
    recognizer.decode(stream);
    const text = (recognizer.getResult(stream).text ?? "").trim();
    send({ id: req.id, type: "result", text, loadMs, decodeMs: Date.now() - t1 });
  } catch (err) {
    // A failed build must not leave a half-loaded recognizer behind.
    recognizer = null;
    loaded = "";
    send({
      id: req.id,
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
