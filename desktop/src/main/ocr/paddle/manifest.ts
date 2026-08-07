/**
 * What a PaddleOCR-VL build calls its files, and what ends its answers.
 *
 * Two facts that other code has to agree with, kept away from the runtime
 * so agreeing can be checked without loading a gigabyte of weights: the
 * probe imports this file, and importing `engine.ts` would pull in
 * onnxruntime's native binding instead.
 */

/** The three graphs, named the way the catalogue installed them. */
export function paddleFiles(dtype: string): {
  vision: string;
  decoder: string;
  embedding: string;
} {
  return {
    vision: `onnx/vision_encoder_${dtype}.onnx`,
    decoder: `onnx/decoder_${dtype}.onnx`,
    // Never quantised: an embedding table is pure lookup, so there is
    // nothing to gain, and no build publishes one.
    embedding: "onnx/embedding.onnx",
  };
}

/**
 * Which token ends the answer.
 *
 * 1.5 kept it in both files; 1.6 keeps it only in the generation config.
 * Reading one file and trusting it gives a decoder with no stop sign,
 * which does not fail — it fills the token budget with the same line over
 * and over, and looks like a bad model rather than a missing key.
 */
export function stopToken(
  config: Record<string, number>,
  generation: Record<string, number>,
): number {
  const eos = config["eos_token_id"] ?? generation["eos_token_id"];
  if (eos === undefined) throw new Error("neither config lists an eos_token_id");
  return eos;
}
