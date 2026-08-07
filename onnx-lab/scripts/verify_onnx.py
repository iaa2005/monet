"""
Do the exported graphs read a page the way the real model does?

Shape checks prove nothing here. A vision tower exported with its position
embeddings baked to the example page has exactly the right signature and
reads every other page as noise; the 2×2 patch merge exported in the wrong
order produces confident, fluent, wrong text. So this compares numbers
against the PyTorch model on a real page, and then decodes with the graphs
alone so there is something to read.

    .venv/Scripts/python scripts/verify_onnx.py --image <page.png>
    .venv/Scripts/python scripts/verify_onnx.py --image <page.png> --dtype q8

Two pages, deliberately: whatever the graph was traced with is the one size
it is guaranteed to get right, so a second page of a different shape is the
whole point of the exercise.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForCausalLM, PreTrainedTokenizerFast


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="models/PaddleOCR-VL-1.6")
    p.add_argument("--onnx", default="out/PaddleOCR-VL-1.6-ONNX")
    p.add_argument("--image", required=True)
    p.add_argument("--dtype", default="", help="'' for fp32, or q8")
    p.add_argument("--prompt", default="OCR:")
    p.add_argument("--max-tokens", type=int, default=256)
    p.add_argument("--skip-torch", action="store_true")
    return p.parse_args()


def suffix(dtype: str) -> str:
    return f"_{dtype}" if dtype else ""


def session(path: Path) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.log_severity_level = 3
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def main() -> None:
    args = parse_args()
    model_dir = Path(args.model)
    onnx_dir = Path(args.onnx) / "onnx"

    # The two halves separately rather than through AutoProcessor: the
    # repo's tokenizer_config names the sentencepiece class and ships no
    # sentencepiece model, so transformers tries the slow path and stops.
    # tokenizer.json is complete on its own — which is why the app, whose
    # tokenizer reads that file and nothing else, never met this.
    images = AutoImageProcessor.from_pretrained(
        model_dir, trust_remote_code=True, use_fast=False
    )
    tokenizer = PreTrainedTokenizerFast(
        tokenizer_file=str(model_dir / "tokenizer.json")
    )

    image = Image.open(args.image).convert("RGB")
    vision_batch = images(images=[image], return_tensors="pt")
    pixel_values = vision_batch["pixel_values"]
    grid = vision_batch["image_grid_thw"]
    if pixel_values.dim() == 4:
        pixel_values = pixel_values.unsqueeze(0)

    # One placeholder per MERGED patch — the projector turns each 2×2 block
    # into a single token, so this count and the tower's output length are
    # two independent ways of saying the same number. They are compared
    # below, and disagreeing is the loudest symptom of a bad export.
    frames, rows, columns = (int(v) for v in grid[0])
    merged_tokens = frames * (rows // 2) * (columns // 2)
    text = (
        "<|begin_of_sentence|>User: <|IMAGE_START|>"
        + "<|IMAGE_PLACEHOLDER|>" * merged_tokens
        + "<|IMAGE_END|>"
        + args.prompt
        + "\nAssistant:\n"
    )
    input_ids = tokenizer(text, return_tensors="pt", add_special_tokens=False)[
        "input_ids"
    ]
    print(
        f"page {Path(args.image).name}: {tuple(pixel_values.shape)} "
        f"grid {grid.tolist()} -> {merged_tokens} image tokens"
    )

    vision = session(onnx_dir / f"vision_encoder{suffix(args.dtype)}.onnx")
    started = time.perf_counter()
    embeds = vision.run(
        None,
        {
            "pixel_values": pixel_values.numpy().astype(np.float32),
            "image_grid_thw": grid.numpy().astype(np.int64),
        },
    )[0]
    print(f"vision: {embeds.shape} in {time.perf_counter() - started:.1f}s")

    if not args.skip_torch:
        torch_model = AutoModelForCausalLM.from_pretrained(
            model_dir,
            trust_remote_code=True,
            dtype=torch.float32,
            attn_implementation="eager",
        ).eval()
        with torch.no_grad():
            reference = torch_model.visual(
                pixel_values=pixel_values,
                image_grid_thw=[grid[0]],
                position_ids=torch.arange(pixel_values.shape[1])
                % (grid[0, 1] * grid[0, 2]),
                vision_return_embed_list=True,
                interpolate_pos_encoding=True,
                sample_indices=None,
                cu_seqlens=torch.tensor([0, pixel_values.shape[1]], dtype=torch.int32),
                return_pooler_output=False,
                use_rope=True,
                window_size=-1,
            )
            merged = torch.cat(
                torch_model.mlp_AR(reference.last_hidden_state, [grid[0]]), dim=0
            ).numpy()
        gap = np.abs(merged - embeds)
        cosine = float(
            (merged * embeds).sum()
            / (np.linalg.norm(merged) * np.linalg.norm(embeds) + 1e-9)
        )
        print(
            f"against torch: max |diff| {gap.max():.4f}, mean {gap.mean():.5f}, "
            f"cosine {cosine:.6f}"
        )
        del torch_model

    # ── decode with the graphs alone ────────────────────────────────────
    embedding = session(onnx_dir / "embedding.onnx")
    decoder = session(onnx_dir / f"decoder{suffix(args.dtype)}.onnx")

    ids = input_ids.numpy().astype(np.int64)
    vectors = embedding.run(None, {"input_ids": ids})[0]

    # Both from config.json rather than from the tokenizer: a bare
    # PreTrainedTokenizerFast has no idea which token ends a turn, and a
    # decode loop that never sees its stop sign writes the same line until
    # it runs out of budget.
    # …and 1.6 moved the stop token out of config.json into
    # generation_config.json, where 1.5 had it in both.
    settings = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
    generation = json.loads(
        (model_dir / "generation_config.json").read_text(encoding="utf-8")
    )
    image_token = settings["image_token_id"]
    end_of_text = settings.get("eos_token_id", generation.get("eos_token_id"))
    spots = np.where(ids[0] == image_token)[0]
    if len(spots) != embeds.shape[0]:
        raise SystemExit(
            f"{len(spots)} placeholders but {embeds.shape[0]} image tokens — "
            "the processor and the tower disagree"
        )
    vectors[0, spots] = embeds

    layers = sum(1 for i in decoder.get_inputs() if i.name.endswith(".key"))
    heads, head_dim = 2, 128
    cache = {
        f"past_key_values.{layer}.{kind}": np.zeros(
            (1, heads, 0, head_dim), dtype=np.float32
        )
        for layer in range(layers)
        for kind in ("key", "value")
    }

    produced: list[int] = []
    total = vectors.shape[1]
    step_input = vectors
    started = time.perf_counter()
    for _ in range(args.max_tokens):
        outputs = decoder.run(
            None,
            {
                "inputs_embeds": step_input,
                "attention_mask": np.ones((1, total), dtype=np.int64),
                **cache,
            },
        )
        logits = outputs[0]
        names = [o.name for o in decoder.get_outputs()]
        for name, value in zip(names[1:], outputs[1:]):
            cache[name.replace("present.", "past_key_values.")] = value

        token = int(logits[0, -1].argmax())
        if token == end_of_text:
            break
        produced.append(token)
        step_input = embedding.run(
            None, {"input_ids": np.array([[token]], dtype=np.int64)}
        )[0]
        total += 1

    elapsed = time.perf_counter() - started
    print(
        f"\n{len(produced)} tokens in {elapsed:.1f}s "
        f"({len(produced) / max(elapsed, 1e-9):.1f}/s)\n"
    )
    print(tokenizer.decode(produced, skip_special_tokens=True))


if __name__ == "__main__":
    main()
