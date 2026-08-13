"""
Push the icon detector to the Hub — the repo id the app's downloader names
(see desktop/src/main/computer/omniparser.ts: ICON_REPO).

Same token discipline as publish.py: HF_TOKEN comes from the ENVIRONMENT
and is handed to HfApi for this process only, never written to disk.

    HF_TOKEN=... .venv/Scripts/python scripts/publish_omniparser.py
"""

from __future__ import annotations

import os
from pathlib import Path

from huggingface_hub import HfApi

REPO = "iaa2005/OmniParser-v2-icon-detect-ONNX"
OUT = Path(__file__).resolve().parent.parent / "out" / "OmniParser-v2-icon-detect-ONNX"


def main() -> None:
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("Set HF_TOKEN in the environment (a write-scoped token).")
    api = HfApi(token=token)
    api.create_repo(REPO, exist_ok=True)
    for name in ("model.onnx", "LICENSE"):
        print(f"uploading {name}…")
        api.upload_file(
            path_or_fileobj=str(OUT / name),
            path_in_repo=name,
            repo_id=REPO,
        )
    print(f"done: https://huggingface.co/{REPO}")


if __name__ == "__main__":
    main()
