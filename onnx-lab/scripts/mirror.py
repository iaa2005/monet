"""
Mirror every model the app downloads onto one account.

The app fetches thirteen repos from six different owners. Any one of them
can be renamed, gated or deleted by somebody else, and the app then fails
at install time with a 404 for a user who did nothing wrong. One of them —
the PaddleOCR-VL ONNX — has no upstream at all: it exists only because it
was exported here.

So: copy what the app actually downloads into one namespace, keeping the
licence and saying plainly where each came from.

    HF_TOKEN=... python scripts/mirror.py --check       # licences only
    HF_TOKEN=... python scripts/mirror.py --repo <one>  # mirror one
    HF_TOKEN=... python scripts/mirror.py --all

Only the files the app asks for are copied, not whole repos: the Whisper
repos carry eight quantisations of everything and the app pins fp32. Each
mirror's card says so, so nobody mistakes it for a faithful copy.
"""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download

OWNER = "iaa2005"

# What the app downloads, per subsystem. The patterns are the app's own
# file lists — see the source noted against each.
MODELS: list[dict] = [
    # ── STT: sherpa-onnx / GigaAM (src/main/stt/catalog.ts) ────────────
    {
        "repo": "csukuangfj/sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16",
        "why": "STT, the default — Russian transducer with punctuation",
        "files": ["encoder.int8.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
        # The card declares nothing, but the repo ships a LICENSE: the MIT
        # text, "Copyright (c) 2024 GigaChat Team", pointing at
        # github.com/salute-developers/GigaAM. MIT permits redistribution
        # as long as that notice travels with it, which is why LICENSE is
        # in the file list and not just the weights.
        "licence": "mit",
    },
    {
        "repo": "csukuangfj/sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16",
        "why": "STT, the faster CTC variant",
        "files": ["model.int8.onnx", "tokens.txt"],
        "licence": "mit",  # same LICENSE file, same terms
    },
    {
        "repo": "fussraider/GigaAM-Multilingual-sherpa-onnx-ctc",
        "why": "STT, multilingual — both the base and large variants",
        "files": ["model.int8.onnx", "tokens.txt", "large/model.int8.onnx", "large/tokens.txt"],
    },
    # ── STT: Whisper through transformers.js, pinned to fp32 ───────────
    {
        "repo": "Xenova/whisper-tiny",
        "why": "STT, the small fallback tier",
        "files": [
            "*.json",
            "onnx/encoder_model.onnx",
            "onnx/decoder_model_merged.onnx",
        ],
    },
    {
        "repo": "Xenova/whisper-base",
        "why": "STT, the fallback default",
        "files": [
            "*.json",
            "onnx/encoder_model.onnx",
            "onnx/decoder_model_merged.onnx",
        ],
    },
    {
        "repo": "Xenova/whisper-small",
        "why": "STT, the largest fallback tier",
        "files": [
            "*.json",
            "onnx/encoder_model.onnx",
            "onnx/decoder_model_merged.onnx",
        ],
    },
    # ── TTS (src/main/tts/catalog.ts) ──────────────────────────────────
    {
        "repo": "Supertone/supertonic-3",
        "why": "TTS, the only engine — four graphs and ten voices",
        "files": [
            "onnx/duration_predictor.onnx",
            "onnx/text_encoder.onnx",
            "onnx/vector_estimator.onnx",
            "onnx/vocoder.onnx",
            "onnx/tts.json",
            "onnx/unicode_indexer.json",
            "voice_styles/*.json",
        ],
    },
    # ── OCR page readers (src/main/ocr/models/) ────────────────────────
    {
        "repo": "onnx-community/LightOnOCR-2-1B-ONNX",
        "why": "OCR, the default reader — all three quantisations are offered",
        "files": ["*.json", "*.jinja", "*.txt", "onnx/*"],
    },
    {
        "repo": "onnx-community/GLM-OCR-ONNX",
        "why": "OCR, the fast reader",
        "files": ["*.json", "*.jinja", "*.txt", "onnx/*_q4.onnx*", "onnx/*.onnx_data"],
    },
    # Qwen3-VL-2B-Instruct-ONNX is deliberately absent. It declares no
    # licence anywhere — no card, no README, no LICENSE file — and an
    # undeclared licence means all rights reserved, not "probably fine".
    # It is also the one model here the app never downloads: shelved, with
    # `enabled: false`. If it is ever wanted, the thing to mirror is
    # Qwen/Qwen3-VL-2B-Instruct, which IS Apache 2.0, and to re-export.
    # ── OCR helpers ────────────────────────────────────────────────────
    {
        "repo": "PaddlePaddle/PP-DocLayout_plus-L_onnx",
        "why": "OCR, the block finder — without it pages are read whole and slowly",
        "files": ["inference.onnx", "*.yml", "*.json"],
    },
    {
        "repo": "PaddlePaddle/PP-OCRv5_mobile_det_onnx",
        "why": "OCR, the line detector that measures page skew",
        "files": ["inference.onnx", "*.yml", "*.json"],
    },
]

# Licences that permit redistribution with attribution. Anything else is
# reported and NOT copied — a mirror is a redistribution, and the point of
# this exercise is not to create a different kind of problem.
REDISTRIBUTABLE = {
    "apache-2.0",
    "mit",
    "bsd-3-clause",
    "bsd-2-clause",
    "cc-by-4.0",
    "cc0-1.0",
    "openrail",
    "bigscience-openrail-m",
    "creativeml-openrail-m",
    "unlicense",
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--check", action="store_true", help="report licences, copy nothing")
    p.add_argument("--repo", help="mirror one repo by its upstream id")
    p.add_argument("--all", action="store_true")
    p.add_argument("--work", default="models/mirror")
    return p.parse_args()


def api() -> HfApi:
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN is not set in the environment")
    return HfApi(token=token)


def licence_of(hub: HfApi, model: dict) -> tuple[str, bool, str]:
    """(licence, may redistribute, note).

    The card's metadata field is the first place to look and often empty —
    several of these ship a LICENSE file and leave the YAML blank. Where
    that file was READ and found to permit redistribution, the entry says
    so explicitly; a guess is not good enough to redistribute on.
    """
    repo = model["repo"]
    try:
        info = hub.model_info(repo)
    except Exception as err:  # gated, renamed, deleted — all worth seeing
        return ("?", False, f"cannot read: {type(err).__name__}")
    card = info.card_data or {}
    declared = (card.get("license") or "").lower()
    stated = model.get("licence", "")
    licence = declared or stated or "none declared"
    if info.gated:
        return (licence, False, f"GATED ({info.gated})")
    note = "" if declared else ("from its LICENSE file" if stated else "")
    return (licence, licence in REDISTRIBUTABLE, note)


def completeness(copied: int, upstream: int) -> str:
    """Say what was actually copied, rather than assert it.

    Some of these end up complete — the file patterns for the OCR readers
    take every graph, because the app offers three quantisations and a
    partial copy would break the two nobody tested. Others are narrow on
    purpose: the Whisper repos carry eight quantisations and the app pins
    one. A card that claims the wrong one of those is a card nobody should
    trust about anything else either.
    """
    if copied >= upstream:
        return (
            "This is a **complete copy**: every file the original publishes."
        )
    return (
        f"Only the files the application downloads are here — {copied} of "
        f"the original's {upstream} — so this is **not a complete copy**."
    )


def card_for(model: dict, licence: str, copied: int = 0, upstream: int = 0) -> str:
    # No `base_model_relation`: the Hub validates it against a fixed list
    # — finetune, adapter, merge, quantized — and a plain copy is none of
    # those. An invalid value fails the upload, not just the card.
    return f"""---
license: {licence}
base_model: {model["repo"]}
tags:
  - mirror
---

# {model["repo"].split("/")[-1]}

A mirror of [{model["repo"]}](https://huggingface.co/{model["repo"]}),
kept so that one desktop application has a single place its models can be
fetched from. **Use the original** — this copy exists to survive a rename,
not to be better.

Purpose in that app: {model["why"]}.

{completeness(copied, upstream)} The licence and the credit belong to the
original authors; nothing here is modified.
"""


def mirror(hub: HfApi, model: dict, work: Path) -> None:
    repo = model["repo"]
    licence, allowed, note = licence_of(hub, model)
    if not allowed:
        print(f"SKIP  {repo}\n      licence {licence} {note}".rstrip())
        return

    target = f"{OWNER}/{repo.split('/')[-1]}"
    print(f"\n{repo}  ({licence})\n  -> {target}")

    local = work / repo.replace("/", "__")
    snapshot_download(
        repo,
        local_dir=str(local),
        # LICENSE and NOTICE always travel: for two of these they are the
        # only statement of terms there is, and MIT requires the notice to
        # come with the copy.
        allow_patterns=[*model["files"], "LICENSE*", "NOTICE*", "*.md"],
    )
    got = [p for p in local.rglob("*") if p.is_file() and ".cache" not in p.parts]
    size = sum(p.stat().st_size for p in got)
    print(f"  {len(got)} files, {size / 1024 / 1024:.0f} MB")

    upstream = len(hub.model_info(repo).siblings)
    (local / "README.md").write_text(
        card_for(model, licence, len(got), upstream), encoding="utf-8"
    )

    hub.create_repo(target, repo_type="model", exist_ok=True)
    hub.upload_folder(
        folder_path=str(local),
        repo_id=target,
        ignore_patterns=[".cache/*", ".gitattributes"],
        commit_message=f"Mirror of {repo}",
    )
    print(f"  https://huggingface.co/{target}")
    shutil.rmtree(local, ignore_errors=True)


def main() -> None:
    args = parse_args()
    hub = api()
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)

    if args.check:
        print(f"{'licence':<24} {'copy?':<6} repo")
        for model in MODELS:
            licence, allowed, note = licence_of(hub, model)
            mark = "yes" if allowed else "NO"
            print(f"{licence:<24} {mark:<6} {model['repo']} {note}".rstrip())
        return

    wanted = [m for m in MODELS if not args.repo or m["repo"] == args.repo]
    if not wanted:
        raise SystemExit(f"no such repo in the list: {args.repo}")
    for model in wanted:
        mirror(hub, model, work)


if __name__ == "__main__":
    main()
