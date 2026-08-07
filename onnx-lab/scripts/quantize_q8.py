"""
fp32 ONNX -> q8, the quantisation that was measured to be safe.

Why q8 and not q4: on the 1.5 build, q4 weights read "большом количестве"
as "доплыком колпистстве" — fluent, confident, wrong — while q8 read it
correctly. q4 halves the download again and it is not worth finding out
whether this model tolerates it better; a comparison of 1.5 against 1.6
should differ in the version, not in the arithmetic.

Dynamic quantisation, weights only. It needs no calibration data, which
matters here: a calibration set for a document model would be a corpus of
scanned pages, and getting it wrong biases the result in ways that look
like the model being bad.

    .venv/Scripts/python scripts/quantize_q8.py out/PaddleOCR-VL-1.6-ONNX
"""

from __future__ import annotations

import sys
from pathlib import Path

import onnx
from onnxruntime.quantization import QuantType, quantize_dynamic


def strip_value_info(src: Path, dst: Path) -> None:
    """Copy a graph with its intermediate shape annotations removed.

    The quantiser re-infers shapes before it starts, and refuses to
    continue when what it infers disagrees with what the file claims:

        Inferred shape and existing shape differ in dimension 0:
        (4608) vs (1024)

    That is the projector, whose 2×2 merge the dynamo exporter recorded
    from before its own optimisation pass reshaped it. The annotations are
    a hint, not part of the model — dropping them lets inference start from
    the nodes, which are right.
    """
    model = onnx.load(str(src))
    model.graph.ClearField("value_info")
    onnx.save(
        model,
        str(dst),
        save_as_external_data=True,
        location=f"{dst.name}.data",
        all_tensors_to_one_file=True,
    )


def quantise(folder: Path) -> None:
    onnx_dir = folder / "onnx"
    if not onnx_dir.is_dir():
        raise SystemExit(f"no onnx/ in {folder}")

    for name in ("vision_encoder", "decoder"):
        src = onnx_dir / f"{name}.onnx"
        if not src.exists():
            print(f"skip {name}: not exported")
            continue

        clean = onnx_dir / f"{name}.clean.onnx"
        dst = onnx_dir / f"{name}_q8.onnx"
        print(f"quantising {src.name} …")
        strip_value_info(src, clean)
        try:
            quantize_dynamic(
                model_input=str(clean),
                model_output=str(dst),
                weight_type=QuantType.QInt8,
                extra_options={
                    # Weights only. Without this the quantiser also rewrites
                    # the attention matmuls, whose inputs are both
                    # activations — that costs accuracy and buys no size,
                    # since there is nothing constant to shrink.
                    "MatMulConstBOnly": True,
                },
            )
        finally:
            clean.unlink(missing_ok=True)
            Path(f"{clean}.data").unlink(missing_ok=True)

        # The weights live beside the graph, so the honest "before" is both
        # files.
        weights = Path(f"{src}.data")
        before = src.stat().st_size + (
            weights.stat().st_size if weights.exists() else 0
        )
        after = dst.stat().st_size
        print(f"  {before / 1024 / 1024:.0f} MB -> {after / 1024 / 1024:.0f} MB")

    # The embedding table stays fp32, as it does in the 1.5 build: it is
    # indexed, never multiplied, so quantising it costs accuracy and saves
    # nothing that matters.
    print("\nembedding.onnx left at full precision (it is a lookup)")


if __name__ == "__main__":
    quantise(Path(sys.argv[1] if len(sys.argv) > 1 else "out/PaddleOCR-VL-1.6-ONNX"))
