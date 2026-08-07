"""
Delete weight sidecars whose graph is not there.

`.onnx` files over 2 GB keep their tensors in a companion `.onnx_data`,
and one of the mirror's file patterns matched every sidecar while another
matched only the q4 graphs. The result is several gigabytes of tensors
belonging to graphs that were never copied: useless on their own,
misleading in a file listing, and charged to somebody's storage.

This removes them, and nothing else. A sidecar is kept if the `.onnx` it
belongs to is in the repo.

    HF_TOKEN=... python scripts/tidy_mirror.py            # report
    HF_TOKEN=... python scripts/tidy_mirror.py --delete
"""

from __future__ import annotations

import argparse
import os
import re

from huggingface_hub import HfApi

from mirror import MODELS, OWNER


def graph_of(sidecar: str) -> str:
    """`onnx/x.onnx_data_1` -> `onnx/x.onnx`."""
    return re.sub(r"\.onnx_data(_\d+)?$", ".onnx", sidecar)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--delete", action="store_true")
    args = parser.parse_args()

    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN is not set in the environment")
    hub = HfApi(token=token)

    for model in MODELS:
        target = f"{OWNER}/{model['repo'].split('/')[-1]}"
        try:
            info = hub.model_info(target, files_metadata=True)
        except Exception:
            continue
        names = {s.rfilename for s in info.siblings}
        sizes = {s.rfilename: (s.size or 0) for s in info.siblings}
        orphans = [
            n for n in names if ".onnx_data" in n and graph_of(n) not in names
        ]
        if not orphans:
            continue
        wasted = sum(sizes[n] for n in orphans) / 1024 / 1024 / 1024
        print(f"\n{target}: {len(orphans)} orphaned sidecars, {wasted:.1f} GB")
        for name in sorted(orphans):
            print(f"  {sizes[name] / 1024 / 1024:8.0f} MB  {name}")
        if args.delete:
            for name in orphans:
                hub.delete_file(
                    path_in_repo=name,
                    repo_id=target,
                    commit_message=f"Remove {name}: its graph is not in this mirror",
                )
            print(f"  deleted {len(orphans)}")

    if not args.delete:
        print("\n(report only — pass --delete to remove them)")


if __name__ == "__main__":
    main()
