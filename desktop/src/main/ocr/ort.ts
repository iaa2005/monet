/**
 * One onnxruntime per process, whichever copy that turns out to be.
 *
 * There are two in the tree: the app depends on onnxruntime-node 1.27, and
 * @huggingface/transformers pins 1.24 in its own node_modules. Loading both
 * native addons into a single process fails with
 *
 *   The requested API version [27] is not available, only API versions
 *   [1, 24] are supported in this build.
 *
 * — and the failure lands on whichever module loaded second, which is never
 * the one at fault. It bit the PaddleOCR runtime first and the line
 * detector second, both times looking like a broken model.
 *
 * So everything that opens a session goes through here: if the library is
 * present, its copy wins, because the library will load its own regardless
 * and cannot be talked out of it.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface OrtModule {
  Tensor: new (type: string, data: unknown, dims: number[]) => any;
  InferenceSession: { create: (path: string, opts?: unknown) => Promise<any> };
}

let cached: OrtModule | null = null;

export function ort(): OrtModule {
  if (cached) return cached;
  try {
    // Resolved from the library's entry point: its `package.json` is not in
    // `exports`, so asking for that path throws before it can help.
    const fromLibrary = createRequire(
      require.resolve("@huggingface/transformers"),
    );
    cached = fromLibrary("onnxruntime-node") as OrtModule;
  } catch {
    // A flat install (npm hoisted them to one version), or a process that
    // does not have the library at all — main, for instance.
    cached = require("onnxruntime-node") as OrtModule;
  }
  return cached;
}
