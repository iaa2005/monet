"""
PP-OCR det+rec on a desktop screenshot — the reference for the app's
TypeScript port (desktop/src/main/computer/ppocr.ts), same contract as
verify_omniparser.py: if the two disagree, this file is right.

det: PP-OCRv3 mobile (DB). Postprocess here is deliberately simplified for
SCREEN text — axis-aligned boxes from connected components on the binarised
probability map, padded by the DB unclip heuristic (area/perimeter). Screen
text is never rotated, so min-area rectangles and polygon clipping earn
nothing.

rec: eslav_PP-OCRv5_mobile (Russian/Ukrainian/Belarusian + Latin + digits),
input 3x48xW — the height is read from the graph, not assumed; CTC over
dict.txt (+ space appended, use_space_char).

    .venv/Scripts/python scripts/verify_ppocr.py --image testdata/screen.png
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DET = ROOT / "models" / "ppocr" / "detection_v3_det.onnx"
REC = ROOT / "models" / "ppocr" / "languages_eslav_rec.onnx"
DICT = ROOT / "models" / "ppocr" / "languages_eslav_dict.txt"

DET_LIMIT = 1920  # limit_side_len for a desktop screenshot; multiple of 32
DET_THRESH = 0.3
BOX_THRESH = 0.5
UNCLIP = 1.8
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
# The graph's width is dynamic; the cap only bounds worst-case cost. A wide
# paragraph line at h=48 needs ~2.4x its pixel width — 640 was squeezing
# 770px screen lines threefold and CTC returned single letters.
REC_MAX_W = 2048


def det_preprocess(img: Image.Image) -> tuple[np.ndarray, float, float]:
    w, h = img.size
    ratio = min(1.0, DET_LIMIT / max(w, h))
    nw = max(32, int(round(w * ratio / 32)) * 32)
    nh = max(32, int(round(h * ratio / 32)) * 32)
    resized = img.resize((nw, nh), Image.BILINEAR)
    arr = np.asarray(resized, dtype=np.float32) / 255.0
    arr = (arr - MEAN) / STD
    return arr.transpose(2, 0, 1)[None], w / nw, h / nh


def connected_boxes(bitmap: np.ndarray, probs: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Axis-aligned boxes of connected components, DB-style unclip padding."""
    h, w = bitmap.shape
    labels = np.zeros((h, w), dtype=np.int32)
    boxes: list[tuple[int, int, int, int]] = []
    next_label = 0
    stack: list[tuple[int, int]] = []
    for sy in range(h):
        for sx in range(w):
            if not bitmap[sy, sx] or labels[sy, sx]:
                continue
            next_label += 1
            stack.append((sy, sx))
            labels[sy, sx] = next_label
            x1, y1, x2, y2 = sx, sy, sx, sy
            count = 0
            score = 0.0
            while stack:
                cy, cx = stack.pop()
                count += 1
                score += float(probs[cy, cx])
                x1 = min(x1, cx); x2 = max(x2, cx)
                y1 = min(y1, cy); y2 = max(y2, cy)
                for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                    if 0 <= ny < h and 0 <= nx < w and bitmap[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = next_label
                        stack.append((ny, nx))
            if count < 12 or score / count < BOX_THRESH:
                continue
            bw, bh = x2 - x1 + 1, y2 - y1 + 1
            pad = int(round(bw * bh * UNCLIP / (2 * (bw + bh))))
            boxes.append((x1 - pad, y1 - pad, x2 + pad, y2 + pad))
    return boxes


def ctc_decode(logits: np.ndarray, charset: list[str]) -> str:
    ids = logits.argmax(axis=-1)
    out: list[str] = []
    prev = 0
    for i in ids:
        if i != 0 and i != prev:
            if i - 1 < len(charset):
                out.append(charset[i - 1])
        prev = i
    return "".join(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--det", default=str(DET), help="detection model path override")
    args = ap.parse_args()

    charset = DICT.read_text(encoding="utf-8").splitlines()
    if " " not in charset:
        charset.append(" ")  # use_space_char

    img = Image.open(args.image).convert("RGB")
    t0 = time.time()
    det = ort.InferenceSession(args.det, providers=["CPUExecutionProvider"])
    inp, rx, ry = det_preprocess(img)
    (prob,) = det.run(None, {det.get_inputs()[0].name: inp})
    probs = prob[0, 0]
    t_det = time.time() - t0

    boxes = connected_boxes(probs > DET_THRESH, probs)
    print(f"det: {len(boxes)} boxes in {t_det:.2f}s (map {probs.shape[1]}x{probs.shape[0]})")

    rec = ort.InferenceSession(str(REC), providers=["CPUExecutionProvider"])
    rec_h = rec.get_inputs()[0].shape[2]
    if not isinstance(rec_h, int):
        rec_h = 48
    t1 = time.time()
    lines: list[tuple[int, int, int, int, str]] = []
    for bx1, by1, bx2, by2 in boxes:
        # Map back to source pixels and crop there — full resolution for rec.
        sx1, sy1 = max(0, int(bx1 * rx)), max(0, int(by1 * ry))
        sx2, sy2 = min(img.size[0], int((bx2 + 1) * rx)), min(img.size[1], int((by2 + 1) * ry))
        if sx2 - sx1 < 4 or sy2 - sy1 < 4:
            continue
        crop = img.crop((sx1, sy1, sx2, sy2))
        cw = min(REC_MAX_W, max(16, int(round(crop.size[0] * rec_h / crop.size[1]))))
        crop = crop.resize((cw, rec_h), Image.BILINEAR)
        arr = np.asarray(crop, dtype=np.float32) / 255.0
        arr = (arr - 0.5) / 0.5
        (logits,) = rec.run(None, {rec.get_inputs()[0].name: arr.transpose(2, 0, 1)[None]})
        text = ctc_decode(logits[0], charset).strip()
        if text:
            lines.append((sx1, sy1, sx2 - sx1, sy2 - sy1, text))
    t_rec = time.time() - t1
    print(f"rec: {len(lines)} lines in {t_rec:.2f}s (h={rec_h})")

    lines.sort(key=lambda l: (l[1], l[0]))
    for x, y, w, h, text in lines[:60]:
        print(f"  ({x},{y} {w}x{h}) {text}")


if __name__ == "__main__":
    main()
