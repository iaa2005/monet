"""
OmniParser v2 icon_detect -> ONNX.

The detector is a plain YOLOv8n fine-tune (see icon_detect/train_args.yaml:
model: yolov8n.pt, imgsz: 1280, single class "icon"), so unlike PaddleOCR-VL
this export is the happy path: ultralytics' own exporter, no patched model
code, no dynamo. The 40 MB .pt shrinks to ~12 MB of fp32 graph once the
training state is dropped.

imgsz stays 1280 — the model was trained there, and icons on a desktop
screenshot are small; 640 loses the tail of them. dynamic=True so the app
may letterbox to smaller sizes when speed matters more.

    .venv/Scripts/python scripts/export_omniparser_detect.py

Output: out/OmniParser-v2-icon-detect-ONNX/model.onnx (+ the licence and a
card), ready for verify_omniparser.py and then publish.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "models" / "OmniParser-v2.0" / "icon_detect"
OUT = ROOT / "out" / "OmniParser-v2-icon-detect-ONNX"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    model = YOLO(str(SRC / "model.pt"))
    exported = model.export(format="onnx", imgsz=1280, dynamic=True, opset=17)
    shutil.move(str(exported), OUT / "model.onnx")
    shutil.copy(str(SRC / "LICENSE"), OUT / "LICENSE")
    print(f"wrote {OUT / 'model.onnx'}")


if __name__ == "__main__":
    main()
