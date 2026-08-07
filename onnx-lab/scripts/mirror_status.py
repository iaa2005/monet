"""
What is on the mirror account, and how much of it.

Run it while `mirror.py --all` is going, or after, to see which repos
exist and whether their file counts look right. The mirror script prints
a URL when it finishes one; this answers the same question from the other
end, which is the one that matters when an upload appears to hang.

    HF_TOKEN=... python scripts/mirror_status.py
"""

from __future__ import annotations

import os

from huggingface_hub import HfApi

EXPECTED = [
    "sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16",
    "sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16",
    "GigaAM-Multilingual-sherpa-onnx-ctc",
    "whisper-tiny",
    "whisper-base",
    "whisper-small",
    "supertonic-3",
    "LightOnOCR-2-1B-ONNX",
    "GLM-OCR-ONNX",
    "PP-DocLayout_plus-L_onnx",
    "PP-OCRv5_mobile_det_onnx",
    "PaddleOCR-VL-1.6-ONNX",
]


def main() -> None:
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN is not set in the environment")
    hub = HfApi(token=token)

    total = 0.0
    done = 0
    for name in EXPECTED:
        try:
            info = hub.model_info(f"iaa2005/{name}", files_metadata=True)
        except Exception as err:
            print(f"    missing            {name}  ({type(err).__name__})")
            continue
        megabytes = sum((s.size or 0) for s in info.siblings) / 1024 / 1024
        total += megabytes
        done += 1
        print(f"{len(info.siblings):3d} files {megabytes:8.0f} MB  {name}")

    print(f"\n{done} of {len(EXPECTED)} repos, {total / 1024:.1f} GB")


if __name__ == "__main__":
    main()
