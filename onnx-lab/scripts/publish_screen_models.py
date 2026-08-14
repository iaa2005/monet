"""
Push everything Computer Use's vision fallback downloads: the OmniParser
icon detector and the PP-OCR det/rec/dict, to the repo ids the app names
(desktop/src/main/computer/{omniparser,ppocr}.ts).

Same token discipline as publish.py: HF_TOKEN comes from the ENVIRONMENT
and is handed to HfApi for this process only, never written to disk.

    HF_TOKEN=... .venv/Scripts/python scripts/publish_screen_models.py
"""

from __future__ import annotations

import os
from pathlib import Path

from huggingface_hub import HfApi

ROOT = Path(__file__).resolve().parent.parent

# repo id -> {path in repo: local file}
PAYLOAD: dict[str, dict[str, Path]] = {
    "iaa2005/OmniParser-v2-icon-detect-ONNX": {
        "model.onnx": ROOT / "out" / "OmniParser-v2-icon-detect-ONNX" / "model.onnx",
        "LICENSE": ROOT / "out" / "OmniParser-v2-icon-detect-ONNX" / "LICENSE",
    },
    "iaa2005/PP-OCR-screen-eslav-ONNX": {
        "det.onnx": ROOT / "models" / "ppocr" / "detection_v3_det.onnx",
        "rec.onnx": ROOT / "models" / "ppocr" / "languages_eslav_rec.onnx",
        "dict.txt": ROOT / "models" / "ppocr" / "languages_eslav_dict.txt",
    },
}


def main() -> None:
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("Set HF_TOKEN in the environment (a write-scoped token).")
    api = HfApi(token=token)
    for repo, files in PAYLOAD.items():
        api.create_repo(repo, exist_ok=True)
        for name, path in files.items():
            print(f"{repo} <- {name}")
            api.upload_file(path_or_fileobj=str(path), path_in_repo=name, repo_id=repo)
        print(f"done: https://huggingface.co/{repo}")


if __name__ == "__main__":
    main()
