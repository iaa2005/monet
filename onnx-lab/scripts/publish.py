"""
Push the built ONNX to the Hub.

The token comes from HF_TOKEN in the ENVIRONMENT and is passed explicitly
to HfApi. Deliberately not `login()`: that writes the token to
~/.cache/huggingface/token, and a write-scoped token belongs in a process,
not on a disk.

    HF_TOKEN=... .venv/Scripts/python scripts/publish.py --whoami
    HF_TOKEN=... .venv/Scripts/python scripts/publish.py --repo <user>/PaddleOCR-VL-1.6-ONNX

Only the q8 build and the config files go up — the fp32 graphs are 3 GB
of intermediate that anyone can rebuild from export_paddleocr_vl.py, and
the app has no use for them.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from huggingface_hub import HfApi

# What the desktop app installs, and nothing else.
PAYLOAD = [
    "onnx/vision_encoder_q8.onnx",
    "onnx/decoder_q8.onnx",
    "onnx/embedding.onnx",
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "processor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "added_tokens.json",
    "special_tokens_map.json",
    "chat_template.jinja",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--repo")
    p.add_argument("--out", default="out/PaddleOCR-VL-1.6-ONNX")
    p.add_argument("--card", default="model-card.md")
    p.add_argument("--whoami", action="store_true")
    p.add_argument("--private", action="store_true")
    return p.parse_args()


def api() -> HfApi:
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN is not set in the environment")
    return HfApi(token=token)


def main() -> None:
    args = parse_args()
    hub = api()

    if args.whoami:
        me = hub.whoami()
        print(f"user: {me['name']}")
        print(f"orgs: {[o['name'] for o in me.get('orgs', [])] or 'none'}")
        for token in me.get("auth", {}).get("accessToken", {}).get("role", ""):
            pass
        print(f"token role: {me.get('auth', {}).get('accessToken', {}).get('role')}")
        return

    if not args.repo:
        raise SystemExit("--repo <user>/<name> is required")

    out = Path(args.out)
    missing = [f for f in PAYLOAD if not (out / f).exists()]
    if missing:
        raise SystemExit(f"not built: {missing}")

    total = sum((out / f).stat().st_size for f in PAYLOAD)
    print(f"{len(PAYLOAD)} files, {total / 1024 / 1024:.0f} MB -> {args.repo}")

    hub.create_repo(args.repo, repo_type="model", private=args.private, exist_ok=True)

    card = Path(args.card)
    if card.exists():
        hub.upload_file(
            path_or_fileobj=str(card),
            path_in_repo="README.md",
            repo_id=args.repo,
            commit_message="Model card",
        )
        print("  README.md")

    for name in PAYLOAD:
        hub.upload_file(
            path_or_fileobj=str(out / name),
            path_in_repo=name,
            repo_id=args.repo,
            commit_message=f"Add {name}",
        )
        print(f"  {name}  {(out / name).stat().st_size / 1024 / 1024:.0f} MB")

    print(f"\nhttps://huggingface.co/{args.repo}")


if __name__ == "__main__":
    main()
