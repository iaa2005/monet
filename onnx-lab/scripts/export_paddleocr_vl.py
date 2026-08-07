"""
PaddleOCR-VL -> three ONNX graphs the desktop app can drive.

The app has no Python and no library that loads this architecture, so it
runs the model as three graphs of its own (desktop/src/main/ocr/paddle).
This produces them in exactly the shapes that runtime expects — the same
shapes the published 1.5 build has, which was read node by node with
inspect_graph.py rather than guessed:

    vision_encoder   pixel_values [1,P,3,14,14], image_grid_thw [1,3]
                     -> image_embeds [P/4, 1024]
    embedding        input_ids [1,S] -> embeddings [1,S,1024]
    decoder          inputs_embeds [1,S,1024], attention_mask [1,T],
                     past_key_values.N.{key,value} [1,2,past,128]
                     -> logits [1,S,vocab], present.N.{key,value}

Run it with the venv beside this folder:

    .venv/Scripts/python scripts/export_paddleocr_vl.py \
        --model PaddlePaddle/PaddleOCR-VL-1.6 --out out/PaddleOCR-VL-1.6-ONNX

Three things about this model that decide how it has to be exported:

  * The vision tower is called in an unusual way. Its own forward has
    fourteen parameters and most combinations do something other than read
    a page; the combination used here is copied from the model's own
    top-level forward — interpolated position embeddings, rope on, pooler
    off, one image. Getting that wrong does not fail, it reads badly.
  * Height and width arrive as VALUES inside image_grid_thw, not as shapes,
    and they resize the position-embedding grid. Only the dynamo exporter
    can turn a value into a dynamic Resize; the classic one bakes in the
    example page and every other page then reads as nonsense. This is why
    the export runs through torch.export with capture_scalar_outputs.
  * The decoder is exported WITH its cache. Exporting it without one
    produces a graph that works for exactly one token and then quietly
    recomputes the whole prompt every step.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import onnx
import torch
from huggingface_hub import snapshot_download
from transformers import AutoConfig, AutoModelForCausalLM


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="PaddlePaddle/PaddleOCR-VL-1.6")
    p.add_argument("--out", default="out/PaddleOCR-VL-1.6-ONNX")
    p.add_argument("--local", default="models/PaddleOCR-VL-1.6")
    p.add_argument("--opset", type=int, default=17)
    p.add_argument(
        "--only",
        default="vision,embedding,decoder",
        help="comma-separated subset, for re-running one graph",
    )
    return p.parse_args()


# ── the model's own source, minus three debug asserts ───────────────────
#
# Each is `sum of the grid == number of patches`, a sanity check on inputs
# this script builds itself. Under torch.export the grid is a tensor whose
# values are not known until the graph runs, so `assert` on it is a
# question the exporter cannot answer and it stops. Removing them changes
# no arithmetic — see the diff against the downloaded file.
ASSERT_MARK = "sum([np.prod(x) for x in"

# The two dynamo-exported graphs are not free to choose their opset. The
# vision tower's position embeddings are a Resize whose size is computed at
# runtime, and no adapter exists to rewrite that node down to 17 — the
# export runs, then fails on the way out. 21 is what the published 1.5
# build uses and what onnxruntime in the app already loads. Only the
# embedding table, which is one Gather, stays wherever --opset points.
DYNAMO_OPSET = 21


def strip_shape_asserts(model_dir: Path) -> None:
    source = model_dir / "modeling_paddleocr_vl.py"
    lines = source.read_text(encoding="utf-8").splitlines(keepends=True)

    out: list[str] = []
    removed = 0
    index = 0
    while index < len(lines):
        line = lines[index]
        if ASSERT_MARK not in line:
            out.append(line)
            index += 1
            continue

        # Walk back to the `assert (` that opens it …
        opener = out.pop()
        while out and not opener.strip().startswith("assert ("):
            opener = out.pop()
        indent = " " * (len(opener) - len(opener.lstrip()))

        # … and forward to the `), (…)` that closes it. Every one of the
        # three carries a message, so the closing line is unambiguous;
        # bailing out after a few lines keeps a future edit from eating
        # the rest of the file.
        limit = index + 6
        while index < len(lines) and index < limit:
            done = lines[index].lstrip().startswith("), (")
            index += 1
            if done:
                break
        out.append(f"{indent}pass  # shape assert removed for ONNX export\n")
        removed += 1

    if removed:
        source.write_text("".join(out), encoding="utf-8")
        print(f"patched {source.name}: {removed} shape asserts removed")
    else:
        print(f"{source.name} already patched")


def retarget_mask_kwarg(model_dir: Path) -> None:
    """`inputs_embeds=` -> `input_embeds=` in the one call that needs it.

    The repo's code was written against transformers 4.55 (its config says
    so) and this venv runs 4.57.6, because 5.x fails earlier still — the
    rope initialiser it wants no longer has a "default" entry. Between 4.55
    and 4.57 `create_causal_mask` renamed its first tensor argument, and
    nothing else in this file noticed.
    """
    source = model_dir / "modeling_paddleocr_vl.py"
    lines = source.read_text(encoding="utf-8").splitlines(keepends=True)

    for index, line in enumerate(lines):
        if "create_causal_mask(" not in line or line.lstrip().startswith("from "):
            continue
        for offset in range(1, 9):
            spot = index + offset
            if spot >= len(lines):
                break
            if lines[spot].lstrip().startswith("inputs_embeds="):
                indent = " " * (len(lines[spot]) - len(lines[spot].lstrip()))
                lines[spot] = f"{indent}input_embeds=inputs_embeds,\n"
                source.write_text("".join(lines), encoding="utf-8")
                print(f"patched {source.name}: causal mask argument renamed")
                return

    print(f"{source.name}: causal mask argument already correct")


def fetch(model_id: str, local: Path) -> Path:
    print(f"fetching {model_id} -> {local}")
    snapshot_download(
        model_id,
        local_dir=str(local),
        allow_patterns=["*.py", "*.json", "*.jinja", "*.safetensors", "*.txt"],
    )
    strip_shape_asserts(local)
    retarget_mask_kwarg(local)
    return local


# ── the three graphs ────────────────────────────────────────────────────


class VisionTower(torch.nn.Module):
    """Page pixels -> the tokens the decoder splices into its prompt.

    The body is the model's own `forward`, lines 2163-2212 of
    modeling_paddleocr_vl.py, with the loop over images unrolled to the one
    image this graph takes and the python-int bookkeeping replaced by the
    same arithmetic on tensors, so the exporter can see it.
    """

    def __init__(self, model: torch.nn.Module):
        super().__init__()
        self.model = model

    def forward(
        self, pixel_values: torch.Tensor, image_grid_thw: torch.Tensor
    ) -> torch.Tensor:
        grid = [image_grid_thw[0]]
        height = image_grid_thw[0, 1]
        width = image_grid_thw[0, 2]

        # Position within the image, repeated per frame — for one page,
        # simply 0..h*w-1.
        patches = pixel_values.shape[1]
        position_ids = torch.arange(patches, device=pixel_values.device) % (
            height * width
        )

        # Where each image starts and ends in the packed sequence. One
        # image, so [0, patches] — built with cumsum because that is what
        # survives the export as a dynamic value.
        counts = image_grid_thw.prod(dim=1)
        cu_seqlens = torch.cat([counts.new_zeros(1), counts.cumsum(0)]).to(torch.int32)

        vision = self.model.visual(
            pixel_values=pixel_values,
            image_grid_thw=grid,
            position_ids=position_ids,
            vision_return_embed_list=True,
            interpolate_pos_encoding=True,
            sample_indices=None,
            cu_seqlens=cu_seqlens,
            return_pooler_output=False,
            use_rope=True,
            window_size=-1,
        )

        # The projector merges each 2×2 block of patches into one token —
        # which is why the app's patchify emits patches in 2×2 order.
        merged = self.model.mlp_AR(vision.last_hidden_state, grid)
        return torch.cat(merged, dim=0)


class Embedding(torch.nn.Module):
    """Token ids -> vectors. A lookup, exported on its own so the decoder
    graph does not carry a 200 MB table it uses once per step."""

    def __init__(self, model: torch.nn.Module):
        super().__init__()
        self.embed = model.get_input_embeddings()

    def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
        return self.embed(input_ids)


class Decoder(torch.nn.Module):
    """The language model, cache in and cache out."""

    def __init__(self, model: torch.nn.Module, num_layers: int):
        super().__init__()
        self.model = model
        self.num_layers = num_layers

    def forward(self, inputs_embeds, attention_mask, *past):
        from transformers.cache_utils import DynamicCache

        cache = DynamicCache()
        for layer in range(self.num_layers):
            # A zero-length cache is the first step; the graph then has the
            # same shape on every step, which is what makes it usable.
            cache.update(past[layer * 2], past[layer * 2 + 1], layer)

        out = self.model.model(
            inputs_embeds=inputs_embeds,
            attention_mask=attention_mask,
            past_key_values=cache,
            use_cache=True,
        )
        logits = self.model.lm_head(out.last_hidden_state)
        flat: list[torch.Tensor] = []
        for layer in range(self.num_layers):
            flat.append(cache.layers[layer].keys)
            flat.append(cache.layers[layer].values)
        return (logits, *flat)


def rename_io(path: Path, inputs: list[str], outputs: list[str]) -> None:
    """Force the graph's input and output names.

    The runtime looks names up rather than positions, and the dynamo
    exporter names things after the python signature it traced. Renaming
    afterwards means the wrapper code can stay readable.
    """
    model = onnx.load(str(path), load_external_data=False)
    mapping: dict[str, str] = {}
    for value, name in zip(model.graph.input, inputs):
        mapping[value.name] = name
    for value, name in zip(model.graph.output, outputs):
        mapping[value.name] = name
    if all(old == new for old, new in mapping.items()):
        return

    for value in list(model.graph.input) + list(model.graph.output):
        value.name = mapping.get(value.name, value.name)
    for node in model.graph.node:
        for i, name in enumerate(node.input):
            node.input[i] = mapping.get(name, name)
        for i, name in enumerate(node.output):
            node.output[i] = mapping.get(name, name)
    onnx.save(model, str(path))
    print(f"  renamed {len(mapping)} tensors")


def export(model_dir: Path, out_dir: Path, opset: int, only: set[str]) -> None:
    onnx_dir = out_dir / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)

    print(f"loading {model_dir} …")
    config = AutoConfig.from_pretrained(model_dir, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_dir,
        trust_remote_code=True,
        dtype=torch.float32,
        # The tower's rope path asks for flash attention and settles for
        # eager; sdpa would fold the mask into an op the exporter writes
        # differently on every torch release.
        attn_implementation="eager",
    ).eval()

    hidden = config.hidden_size
    layers = config.num_hidden_layers
    kv_heads = config.num_key_value_heads
    head_dim = config.head_dim
    print(f"hidden {hidden}, layers {layers}, kv heads {kv_heads}, head dim {head_dim}")

    if "vision" in only:
        print("exporting vision_encoder …")
        # 2×2 patches is one merge unit: the smallest page the tower takes.
        patches = torch.randn(1, 4, 3, 14, 14)
        grid = torch.tensor([[1, 2, 2]], dtype=torch.int64)
        num_patches = torch.export.Dim("num_patches", min=4, max=32768)
        with torch.no_grad():
            torch.onnx.export(
                VisionTower(model),
                (patches, grid),
                str(onnx_dir / "vision_encoder.onnx"),
                dynamic_shapes={"pixel_values": {1: num_patches}, "image_grid_thw": {}},
                opset_version=DYNAMO_OPSET,
                dynamo=True,
                # The page size lives in the grid's VALUES; without this the
                # exporter refuses to make an int out of one.
                optimize=True,
            )
        rename_io(
            onnx_dir / "vision_encoder.onnx",
            ["pixel_values", "image_grid_thw"],
            ["image_embeds"],
        )

    if "embedding" in only:
        print("exporting embedding …")
        ids = torch.tensor([[1, 2, 3, 4]], dtype=torch.int64)
        with torch.no_grad():
            torch.onnx.export(
                Embedding(model),
                (ids,),
                str(onnx_dir / "embedding.onnx"),
                input_names=["input_ids"],
                output_names=["embeddings"],
                dynamic_axes={"input_ids": {1: "seq"}, "embeddings": {1: "seq"}},
                opset_version=opset,
                do_constant_folding=True,
                dynamo=False,
            )
        rename_io(onnx_dir / "embedding.onnx", ["input_ids"], ["embeddings"])

    if "decoder" in only:
        print("exporting decoder …")
        # Traced mid-generation rather than at the first step: a cache of
        # length zero is a dimension the exporter is entitled to fold away,
        # and the graph would then only ever accept an empty one. Length is
        # a dimension here, so the runtime's first step — which really does
        # pass nothing — still fits.
        seq, past_len = 2, 3
        embeds = torch.randn(1, seq, hidden)
        mask = torch.ones(1, seq + past_len, dtype=torch.int64)
        empty: list[torch.Tensor] = []
        for _ in range(layers):
            empty.append(torch.zeros(1, kv_heads, past_len, head_dim))
            empty.append(torch.zeros(1, kv_heads, past_len, head_dim))

        past_names: list[str] = []
        present_names: list[str] = []
        for layer in range(layers):
            for kind in ("key", "value"):
                past_names.append(f"past_key_values.{layer}.{kind}")
                present_names.append(f"present.{layer}.{kind}")

        # The mask is exactly as long as cache plus step. That relation
        # cannot be written down — a named Dim may be scaled and shifted by
        # integers, not added to another Dim — so each axis is marked
        # dynamic and the exporter works the arithmetic out from the trace.
        # DYNAMIC rather than AUTO on purpose: AUTO quietly settles for a
        # constant when it cannot keep an axis open, which here would mean
        # a decoder that reads exactly two tokens.
        #
        # The spec follows the SIGNATURE, not the call: `*past` is one
        # parameter holding a tuple, so its thirty-six entries are nested
        # rather than spread.
        dynamic = torch.export.Dim.DYNAMIC
        shapes = (
            {1: dynamic},
            {1: dynamic},
            tuple({2: dynamic} for _ in past_names),
        )

        with torch.no_grad():
            # Dynamo again, and for a duller reason than the vision tower:
            # transformers builds its causal mask with torch.vmap, which the
            # classic tracer meets as "invalid unordered_map key".
            torch.onnx.export(
                Decoder(model, layers),
                (embeds, mask, *empty),
                str(onnx_dir / "decoder.onnx"),
                dynamic_shapes=shapes,
                opset_version=DYNAMO_OPSET,
                dynamo=True,
                optimize=True,
            )
        rename_io(
            onnx_dir / "decoder.onnx",
            ["inputs_embeds", "attention_mask", *past_names],
            ["logits", *present_names],
        )

    # The runtime reads these by name; copying them keeps the exported
    # folder self-contained, the way the 1.5 build is.
    for name in (
        "config.json",
        "generation_config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "chat_template.jinja",
        "added_tokens.json",
        "special_tokens_map.json",
        "preprocessor_config.json",
        "processor_config.json",
    ):
        src = model_dir / name
        if src.exists():
            shutil.copyfile(src, out_dir / name)

    print(f"\ndone: {out_dir}")
    for f in sorted(onnx_dir.iterdir()):
        print(f"  {f.name}  {f.stat().st_size / 1024 / 1024:.0f} MB")


if __name__ == "__main__":
    args = parse_args()
    local = fetch(args.model, Path(args.local))
    torch._dynamo.config.capture_scalar_outputs = True
    export(local, Path(args.out), args.opset, set(args.only.split(",")))
