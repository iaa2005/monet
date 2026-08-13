"""
Sanity check for the exported icon_detect graph, and the reference for the
app's own runtime: the letterbox, the decode and the NMS below are what
desktop/src/main/computer/omniparser.ts reimplements in TypeScript. If the
two ever disagree, this file is the one that is right.

    .venv/Scripts/python scripts/verify_omniparser.py --image testdata/screen.png

Prints the surviving boxes and writes <image>-boxes.png next to the input
with them drawn on, for eyeballing.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "out" / "OmniParser-v2-icon-detect-ONNX" / "model.onnx"

SIZE = 1280
CONF = 0.15  # OmniParser's own demo threshold territory (they use 0.05-0.3)
IOU = 0.45


def letterbox(img: Image.Image) -> tuple[np.ndarray, float, int, int]:
    """Fit into SIZE x SIZE on grey, keeping aspect. Returns (chw, scale, dx, dy)."""
    w, h = img.size
    scale = min(SIZE / w, SIZE / h)
    nw, nh = round(w * scale), round(h * scale)
    resized = img.resize((nw, nh), Image.BILINEAR)
    canvas = Image.new("RGB", (SIZE, SIZE), (114, 114, 114))
    dx, dy = (SIZE - nw) // 2, (SIZE - nh) // 2
    canvas.paste(resized, (dx, dy))
    arr = np.asarray(canvas, dtype=np.float32) / 255.0
    return arr.transpose(2, 0, 1)[None], scale, dx, dy


def nms(boxes: np.ndarray, scores: np.ndarray, iou_thr: float) -> list[int]:
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        rest = boxes[order[1:]]
        x1 = np.maximum(boxes[i, 0], rest[:, 0])
        y1 = np.maximum(boxes[i, 1], rest[:, 1])
        x2 = np.minimum(boxes[i, 2], rest[:, 2])
        y2 = np.minimum(boxes[i, 3], rest[:, 3])
        inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
        area_i = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
        area_r = (rest[:, 2] - rest[:, 0]) * (rest[:, 3] - rest[:, 1])
        iou = inter / (area_i + area_r - inter + 1e-9)
        order = order[1:][iou <= iou_thr]
    return keep


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--conf", type=float, default=CONF)
    args = ap.parse_args()

    img = Image.open(args.image).convert("RGB")
    inp, scale, dx, dy = letterbox(img)

    sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    (out,) = sess.run(None, {sess.get_inputs()[0].name: inp})
    # (1, 5, N): cx, cy, w, h, conf — single class, already sigmoided.
    pred = out[0].T  # (N, 5)
    pred = pred[pred[:, 4] >= args.conf]
    if pred.size == 0:
        print("no boxes above threshold")
        return
    cx, cy, w, h = pred[:, 0], pred[:, 1], pred[:, 2], pred[:, 3]
    boxes = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], axis=1)
    # Undo the letterbox back into source-image pixels.
    boxes[:, [0, 2]] = (boxes[:, [0, 2]] - dx) / scale
    boxes[:, [1, 3]] = (boxes[:, [1, 3]] - dy) / scale
    keep = nms(boxes, pred[:, 4], IOU)

    draw_img = img.copy()
    draw = ImageDraw.Draw(draw_img)
    for i in keep:
        x1, y1, x2, y2 = boxes[i]
        draw.rectangle([x1, y1, x2, y2], outline=(255, 60, 60), width=2)
    out_path = Path(args.image).with_name(Path(args.image).stem + "-boxes.png")
    draw_img.save(out_path)
    print(f"{len(keep)} boxes (of {len(pred)} above conf) -> {out_path}")


if __name__ == "__main__":
    main()
