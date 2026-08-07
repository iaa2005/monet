"""
Copy whatever a mirror is missing, for a mirror that should be complete.

Written for one case that generalises. The GLM-OCR mirror came out
incoherent: one file pattern matched every `.onnx_data` sidecar while
another matched only the q4 graphs, so it ended up holding 7.7 GB of
tensors belonging to graphs it did not have. Deleting them was the
obvious fix and the wrong one — the expensive part was already uploaded,
and the missing pieces were thirteen files totalling 351 MB, twelve of
them under half a megabyte. Filling in cost a rounding error and turned a
misleading partial copy into a complete one.

    HF_TOKEN=... python scripts/fill_mirror.py --repo GLM-OCR-ONNX

Not the default for every mirror: the Whisper repos publish eight
quantisations of everything and the app pins one, so completing those
would copy gigabytes nobody will ever load.
"""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download

from mirror import MODELS, OWNER


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True, help="the mirror's short name")
    p.add_argument("--work", default="models/fill")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN is not set in the environment")
    hub = HfApi(token=token)

    model = next(
        (m for m in MODELS if m["repo"].split("/")[-1] == args.repo), None
    )
    if not model:
        raise SystemExit(f"{args.repo} is not one of the mirrored models")
    upstream = model["repo"]
    target = f"{OWNER}/{args.repo}"

    have = {s.rfilename for s in hub.model_info(target).siblings}
    missing = [
        s.rfilename
        for s in hub.model_info(upstream).siblings
        # The mirror writes its own card, and .gitattributes is the Hub's.
        if s.rfilename not in have
        and s.rfilename not in ("README.md", ".gitattributes")
    ]
    if not missing:
        print(f"{target} is already complete")
        return

    print(f"{len(missing)} files to copy from {upstream}")
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    try:
        for name in missing:
            local = hf_hub_download(upstream, name, local_dir=str(work))
            hub.upload_file(
                path_or_fileobj=local,
                path_in_repo=name,
                repo_id=target,
                commit_message=f"Add {name}",
            )
            size = Path(local).stat().st_size / 1024 / 1024
            print(f"  {size:8.1f} MB  {name}")
            Path(local).unlink(missing_ok=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(f"\nhttps://huggingface.co/{target}")


if __name__ == "__main__":
    main()
