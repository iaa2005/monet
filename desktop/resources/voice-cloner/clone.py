#!/usr/bin/env python
"""
Clone your voice into a Supertonic 3 style file.

    python clone.py voice.wav --name Sasha --minutes 20

What it does: Supertonic's voice is two style tensors. This program treats them
as the only unknowns and optimises them until the speech the model produces
matches the recording you gave it:

    style -> text encoder -> flow matching -> vocoder -> waveform
                                                            |
        loss = 1 - cosine( CAM++(that waveform), CAM++(your recording) )

A WavLM layer-4 objective was tried and dropped, with numbers: see the README.

Every arrow is differentiable, so this is gradient descent on the voice itself,
not a search among presets. It writes `<name>.json`, which Code Monet imports
in Settings → Voice → Import a voice file.

Why this is a separate program and not part of the app: the app runs the model
through onnxruntime, which does inference only. Gradients need PyTorch, and
PyTorch is two gigabytes.

Honest expectations:
  - CPU: allow half an hour or more. A GPU (CUDA, or Intel XPU) is much faster.
  - The result is a likeness, not a forgery. Watch the printed similarity: it
    starts around 0.2-0.4 and climbing past ~0.7 is a good voice.
  - 20-40 seconds of clean speech, one speaker, no music. More is not better.

Requires: pip install -r requirements.txt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import soundfile as sf
import torch
import torch.nn.functional as F
import torchaudio

# ── The two shims that make the ONNX graphs differentiable ───────────────
#
# Both were found the hard way against the published models (opset 19):
#
#   1. onnx2torch's registry stops at opset 13 for a dozen ops whose semantics
#      never changed (Shape, Constant, ...). Alias the highest known converter
#      up to 23 and everything resolves.
#   2. Its Clip converter refuses min/max that are not attributes. Every Clip
#      here has a min and no max, and `Clip(x, min)` IS `Max(x, min)` — a
#      one-node rewrite, exactly equal, and Max converts.

from onnx2torch import convert  # noqa: E402
from onnx2torch.node_converters.registry import (  # noqa: E402
    _CONVERTER_REGISTRY,
    OperationDescription,
)


# A Windows console is cp1251 here, and a stray arrow in a progress line is
# not worth a UnicodeEncodeError two minutes into a run.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def widen_converter_registry() -> None:
    best: dict[tuple[str, str], tuple[int, object]] = {}
    for desc, conv in list(_CONVERTER_REGISTRY.items()):
        key = (desc.domain, desc.operation_type)
        if key not in best or desc.version > best[key][0]:
            best[key] = (desc.version, conv)
    for (domain, op), (version, conv) in best.items():
        for v in range(version + 1, 24):
            _CONVERTER_REGISTRY.setdefault(
                OperationDescription(domain=domain, operation_type=op, version=v), conv
            )


def declip(model: onnx.ModelProto) -> None:
    for node in model.graph.node:
        if node.op_type == "Clip" and (
            len(node.input) == 2 or (len(node.input) == 3 and node.input[2] == "")
        ):
            node.op_type = "Max"
            del node.input[2:]


def as_torch(path: Path, device: torch.device, cache: Path) -> torch.nn.Module:
    """ONNX file -> torch module. Folds constants through onnxruntime first, so
    Clip's bounds arrive as initialisers rather than as graph nodes.

    The folded copies go in the tool's own cache dir: they are as big as the
    originals and the app's model folder is not ours to fill."""
    cache.mkdir(parents=True, exist_ok=True)
    folded = cache / (path.stem + ".folded.onnx")
    if not folded.exists():
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        so.optimized_model_filepath = str(folded)
        ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
    model = onnx.load(str(folded))
    declip(model)
    return convert(model).to(device).eval()


# ── The speaker model: who is talking ───────────────────────────────────

SPEAKER_URL = (
    "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/"
    "wespeaker_en_voxceleb_CAM%2B%2B_LM.onnx"
)
SPEAKER_FILE = "wespeaker_en_voxceleb_CAM++_LM.onnx"
SPEAKER_BYTES = 29_292_687
SPEAKER_SHA256 = "e197af7e9d473030cf486b3124149a19bf37014d0e4485e4c70c483b0ec10cb2"


def fetch_checked(url: str, target: Path, size: int, sha256: str, tries: int = 40) -> None:
    """Download to `.part`, resume, verify, THEN rename.

    Written after the first version lost the connection at 28.5 of 29.3 MB and
    left the stump in place — the next run read it as the model and died on
    "Protobuf parsing failed", which says nothing about the real problem. A
    partial file must never be able to masquerade as a complete one.

    `tries` is high on purpose. Measured on the connection this was built on,
    the transfer dropped every 100-200 KB over the last megabyte: each attempt
    resumed and made progress, and six was not enough to finish while forty is
    plenty. Since every attempt continues where the last stopped, a high number
    costs nothing when the network behaves.
    """
    part = target.with_name(target.name + ".part")
    for attempt in range(1, tries + 1):
        have = part.stat().st_size if part.exists() else 0
        if have > size:
            part.unlink()
            have = 0
        req = urllib.request.Request(url, headers={"User-Agent": "code-monet-cloner"})
        if have:
            req.add_header("Range", f"bytes={have}-")
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                # A server may ignore Range and send the whole file with 200 —
                # appending that to what we have would corrupt it silently.
                if have and res.status != 206:
                    have = 0
                mode = "ab" if have else "wb"
                with open(part, mode) as f:
                    while True:
                        chunk = res.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        done = f.tell()
                        print(
                            f"\r  {done * 100 // size}% ({done // 1_000_000} of "
                            f"{size // 1_000_000} MB)",
                            end="",
                            flush=True,
                        )
            print()
        except Exception as err:  # noqa: BLE001 - any network failure retries
            print(f"\n  attempt {attempt}/{tries} failed ({err}); resuming")
            continue
        got = part.stat().st_size
        if got != size:
            print(f"  {attempt}/{tries}: {got} of {size} bytes; resuming")
            time.sleep(min(5.0, 0.5 * attempt))
            continue
        digest = hashlib.sha256(part.read_bytes()).hexdigest()
        if digest != sha256:
            print("  checksum mismatch, starting over")
            part.unlink()
            continue
        part.replace(target)
        return
    sys.exit(
        f"could not download {target.name} after {tries} attempts." + "\n"
        f"Download it by hand from {url}\nand put it next to clone.py."
    )


def speaker_model(work: Path, device: torch.device) -> torch.nn.Module:
    path = work / SPEAKER_FILE
    # An earlier version of the app downloaded this same model; if it is still
    # in the data dir, 29 MB does not need fetching twice.
    if not path.exists():
        beside = work.parent / "tts-models" / "speaker" / SPEAKER_FILE
        if beside.exists() and beside.stat().st_size == SPEAKER_BYTES:
            print(f"using the copy already in {beside.parent}")
            path = beside
    # Size first, every run: a stump from an interrupted download is the one
    # state that looks installed and is not.
    if path.exists() and path.stat().st_size != SPEAKER_BYTES:
        print(f"{path.name} is {path.stat().st_size} bytes, expected {SPEAKER_BYTES} - refetching")
        path.unlink()
    if not path.exists():
        print(f"downloading the speaker model ({SPEAKER_BYTES // 1_000_000} MB)")
        fetch_checked(SPEAKER_URL, path, SPEAKER_BYTES, SPEAKER_SHA256)
    return as_torch(path, device, work / "cache")


def fbank(wav16k: torch.Tensor) -> torch.Tensor:
    """80-dim kaldi fbank, mean-normalised — what WeSpeaker's CAM++ expects.
    Differentiable, which rules out the C++ feature extractors."""
    feats = torchaudio.compliance.kaldi.fbank(
        wav16k.unsqueeze(0) * 32768.0,
        num_mel_bins=80,
        frame_length=25.0,
        frame_shift=10.0,
        dither=0.0,
        energy_floor=0.0,
        sample_frequency=16000,
    )
    return (feats - feats.mean(dim=0, keepdim=True)).unsqueeze(0)


def embed_waveform(
    wav: torch.Tensor, rate: int, speaker: torch.nn.Module
) -> torch.Tensor:
    wav16k = (
        wav if rate == 16000 else torchaudio.functional.resample(wav, rate, 16000)
    )
    return speaker(fbank(wav16k))


# ── The synthesiser, in torch ───────────────────────────────────────────


class Supertonic:
    def __init__(self, model_dir: Path, device: torch.device, cache: Path):
        cfg = json.loads((model_dir / "tts.json").read_text("utf-8"))
        self.sample_rate = int(cfg["ae"]["sample_rate"])
        self.chunk = int(cfg["ae"]["base_chunk_size"]) * int(
            cfg["ttl"]["chunk_compress_factor"]
        )
        self.latent_dim = int(cfg["ttl"]["latent_dim"]) * int(
            cfg["ttl"]["chunk_compress_factor"]
        )
        self.indexer = json.loads(
            (model_dir / "unicode_indexer.json").read_text("utf-8")
        )
        self.device = device
        print("converting the model to torch (once, about a minute)...")
        self.dp = as_torch(model_dir / "duration_predictor.onnx", device, cache)
        self.enc = as_torch(model_dir / "text_encoder.onnx", device, cache)
        self.est = as_torch(model_dir / "vector_estimator.onnx", device, cache)
        self.voc = as_torch(model_dir / "vocoder.onnx", device, cache)

    def ids(self, text: str, lang: str) -> torch.Tensor:
        # The app's own preprocessing, reduced to what matters here: the model
        # reads a language-tagged string, character by character.
        wrapped = f"<{lang}>{text.strip()}</{lang}>"
        # unicode_indexer.json is a 65536-long LIST indexed by code point, with
        # -1 for "not in the table" — which the app passes through as-is, so
        # this does too rather than inventing a different tokenisation.
        idx = [
            self.indexer[ord(ch)] if ord(ch) < len(self.indexer) else 0
            for ch in wrapped
        ]
        return torch.tensor([idx], dtype=torch.int64, device=self.device)

    def speak(
        self,
        style_ttl: torch.Tensor,
        # Detached by nature: it only reaches the duration predictor, and that
        # answer becomes a sample count. No gradient can come back through it.
        style_dp: torch.Tensor,
        text: str,
        lang: str,
        steps: int,
        seconds: float | None = None,
    ) -> torch.Tensor:
        ids = self.ids(text, lang)
        n = ids.shape[1]
        mask = torch.ones(1, 1, n, device=self.device)
        if seconds is None:
            with torch.no_grad():
                seconds = float(
                    self.dp(ids, style_dp.detach(), mask).reshape(-1)[0]
                )
        emb = self.enc(ids, style_ttl, mask)
        wav_len = int(seconds * self.sample_rate)
        latent_len = max(1, (wav_len + self.chunk - 1) // self.chunk)
        latent = torch.randn(1, self.latent_dim, latent_len, device=self.device)
        latent_mask = torch.ones(1, 1, latent_len, device=self.device)
        total = torch.tensor([float(steps)], device=self.device)
        # POSITIONAL, in the graph's own input order — the app passes these by
        # name and the order is not the obvious one:
        #   noisy_latent, text_emb, style_ttl, latent_mask, text_mask,
        #   current_step, total_step
        # Getting it wrong costs a shape error deep inside the estimator, where
        # it reads as a length bug rather than an argument-order bug.
        for step in range(steps):
            latent = self.est(
                latent,
                emb,
                style_ttl,
                latent_mask,
                mask,
                torch.tensor([float(step)], device=self.device),
                total,
            )
        wav = self.voc(latent).reshape(-1)
        return wav[:wav_len] if wav.numel() > wav_len > 0 else wav


# ── Target ──────────────────────────────────────────────────────────────


def target_embedding(
    path: Path,
    speaker: torch.nn.Module,
    device: torch.device,
) -> torch.Tensor:
    audio, rate = sf.read(str(path), dtype="float32", always_2d=True)
    mono = torch.tensor(audio.mean(axis=1), device=device)
    if mono.numel() < rate * 3:
        sys.exit("that clip is under three seconds — record 20-40 s of speech")
    # Several windows, averaged: one four-second slice of a recording can be
    # unrepresentative (a cough, a pause, one loud word).
    window = min(int(4.0 * rate), mono.numel())
    hop = max(1, (mono.numel() - window) // 5)
    with torch.no_grad():
        embs = [
            embed_waveform(mono[p : p + window], rate, speaker)
            for p in range(0, mono.numel() - window + 1, hop)
        ][:6]
    stacked = torch.cat(embs, dim=0).mean(dim=0, keepdim=True)
    print(f"target from {mono.numel() / rate:.0f} s of audio, {len(embs)} windows")
    return F.normalize(stacked, dim=-1)


# ── Optimise ────────────────────────────────────────────────────────────

TEXTS = {
    "ru": [
        "Проверяю, как звучит этот голос на длинной фразе с обычными словами.",
        "Сегодня я закончил работу раньше и успел прогуляться по городу.",
    ],
    "en": [
        "Checking how this voice sounds on a longer sentence of ordinary words.",
        "I finished the work earlier today and had time for a walk.",
    ],
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("recording", type=Path, help="wav/flac/ogg of your voice")
    ap.add_argument("--name", default="my-voice", help="output file stem")
    ap.add_argument(
        "--models",
        type=Path,
        default=None,
        help="Supertonic model dir (default: the app's tts-models/supertonic-3)",
    )
    ap.add_argument("--lang", default="ru", choices=sorted(TEXTS))
    ap.add_argument("--minutes", type=float, default=20.0, help="time budget")
    ap.add_argument("--steps", type=int, default=4, help="flow steps per pass")
    ap.add_argument(
        "--draws",
        type=int,
        default=4,
        help="renderings averaged per step. Four costs four times a step and "
        "removes the wobble: on a benchmark with a known answer, one draw "
        "plateaued at 0.71 after fourteen minutes and then wandered for eleven "
        "more, while four was still climbing at the buzzer (0.725 to 0.749 over "
        "the last eleven). The honest scores were 0.7105 against 0.7004, which "
        "on its own is inside the noise — the trajectory is the reason for this "
        "default, not that 0.010",
    )
    ap.add_argument(
        "--lr",
        type=float,
        default=1e-3,
        help="step size. The style's own values average 0.02, so 0.02 here "
        "destroys the voice in three steps — measured, not guessed",
    )
    ap.add_argument(
        "--anchor",
        type=float,
        default=0.02,
        help="pull towards the starting preset; higher = safer, less like you",
    )
    ap.add_argument("--init", default=None, help="preset to start from (F1…M5)")
    ap.add_argument(
        "--init-json",
        type=Path,
        default=None,
        help="start from a style file instead of a preset — inverse.py writes one "
        "in seconds, and descent from there beats descent from the nearest preset",
    )
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda", "xpu"])
    args = ap.parse_args()

    widen_converter_registry()

    if args.device == "auto":
        if torch.cuda.is_available():
            dev = "cuda"
        elif hasattr(torch, "xpu") and torch.xpu.is_available():
            dev = "xpu"
        else:
            dev = "cpu"
    else:
        dev = args.device
    device = torch.device(dev)
    print(f"device: {dev}")

    work = Path(__file__).resolve().parent
    models = args.models or (work.parent / "tts-models" / "supertonic-3")
    if not (models / "vocoder.onnx").exists():
        sys.exit(
            f"no Supertonic model in {models}\n"
            "install the voice in Code Monet (Settings → Voice) or pass --models"
        )

    speaker = speaker_model(work, device)
    target = target_embedding(args.recording, speaker, device)
    tts = Supertonic(models, device, work / "cache")

    def measure(wav: torch.Tensor) -> torch.Tensor:
        """How like the recording this utterance sounds, 0…1."""
        wav16k = torchaudio.functional.resample(wav, tts.sample_rate, 16000)
        emb = F.normalize(speaker(fbank(wav16k)), dim=-1)
        return (emb @ target.T).reshape(())

    def say_and_measure(
        ttl: torch.Tensor, dp: torch.Tensor, text: str, draws: int
    ) -> torch.Tensor:
        """Speak the line `draws` times and score the AVERAGE of the embeddings.

        The flow sampler draws fresh noise per utterance, so one rendering is a
        noisy view of the voice: the same style spoken twice scores only 0.92
        against itself. Averaging k of them divides that noise by root k without
        ever fixing a draw — fixing them was tried, and drove the score to +0.909
        while the honest number stayed at +0.673."""
        if draws <= 1:
            return measure(tts.speak(ttl, dp, text, args.lang, args.steps))
        embs = []
        for _ in range(draws):
            wav = tts.speak(ttl, dp, text, args.lang, args.steps)
            wav16k = torchaudio.functional.resample(wav, tts.sample_rate, 16000)
            embs.append(F.normalize(speaker(fbank(wav16k)), dim=-1))
        emb = F.normalize(torch.cat(embs).mean(dim=0, keepdim=True), dim=-1)
        return (emb @ target.T).reshape(())

    # Start from the preset that already sounds nearest: gradient descent from
    # a plausible voice beats descent from noise, and it keeps the result on
    # the manifold the model was trained on.
    presets = sorted(p for p in models.glob("[FM][0-9].json"))
    if not presets:
        sys.exit("no preset styles next to the model — select a voice in the app once")
    texts = TEXTS[args.lang]

    def style_of(path: Path) -> tuple[torch.Tensor, torch.Tensor]:
        j = json.loads(path.read_text("utf-8"))
        ttl = torch.tensor(
            np.array(j["style_ttl"]["data"], dtype=np.float32).reshape(1, 50, 256),
            device=device,
        )
        dp = torch.tensor(
            np.array(j["style_dp"]["data"], dtype=np.float32).reshape(1, 8, 16),
            device=device,
        )
        return ttl, dp

    if args.init_json:
        start = args.init_json
        print(f"starting from {start}")
    elif args.init:
        start = models / f"{args.init}.json"
    else:
        print("scoring the presets…")
        best, start = -2.0, presets[0]
        scored: dict[str, float] = {}
        for path in presets:
            ttl, dp = style_of(path)
            with torch.no_grad():
                # Averaged like the loss is: a single rendering wobbles by ±0.03,
                # which is a third of the whole spread across these ten and quite
                # enough to crown the wrong preset.
                score = float(say_and_measure(ttl, dp, texts[0], args.draws))
            scored[path.stem] = score
            print(f"  {path.stem}: {score:+.3f}")
            if score > best:
                best, start = score, path
        # THE CHEAP DIAGNOSTIC. A metric that scores ten different voices within
        # a hair of each other has no gradient to give, and finding that out
        # after fifteen minutes of descent is finding it out too late: a
        # WavLM-statistics objective tried here spanned 0.005 across these ten
        # and rated female voices above male ones.
        spread = max(scored.values()) - min(scored.values())
        males = [v for k, v in scored.items() if k.startswith("M")]
        females = [v for k, v in scored.items() if k.startswith("F")]
        gap = sum(males) / len(males) - sum(females) / len(females)
        print(
            f"spread across the ten: {spread:.3f}"
            f"  (male-female gap {gap:+.3f})"
        )
        if spread < 0.02:
            sys.exit(
                "the objective cannot tell these ten voices apart, so it cannot"
                " fit yours either — check the recording (one speaker, no music)"
            )
        print(f"starting from {start.stem} ({best:+.3f})")

    ttl0, dp0 = style_of(start)
    style_ttl = ttl0.clone().requires_grad_(True)
    # style_dp is NOT optimised, and cannot be: it feeds only the duration
    # predictor, whose output becomes an integer number of samples — a shape,
    # not a differentiable quantity. An earlier version handed it to Adam
    # anyway; the only gradient it ever received came from the anchor term
    # pulling it back where it started, which is an expensive way to change
    # nothing. The rhythm therefore stays that of the nearest preset.
    style_dp = dp0.clone()
    opt = torch.optim.Adam([style_ttl], lr=args.lr)

    started = time.time()
    deadline = started + args.minutes * 60
    it = 0
    smooth = 0.0
    best_score = -2.0
    best_state = (ttl0.clone(), dp0.clone())
    # Where the score stood three quarters of the way in. If it kept climbing
    # after that, the run ended on the budget rather than on the method, and
    # saying so is worth more than any flag: a 12-minute run that reached 0.673
    # was continued for 45 minutes more and reached 0.886.
    quarter_mark, at_quarter = started + args.minutes * 45, None
    while time.time() < deadline:
        if at_quarter is None and time.time() > quarter_mark:
            at_quarter = best_score
        it += 1
        text = texts[it % len(texts)]
        opt.zero_grad(set_to_none=True)
        similarity = say_and_measure(style_ttl, style_dp, text, args.draws)
        anchor = ((style_ttl - ttl0) ** 2).mean()
        (1.0 - similarity + args.anchor * anchor).backward()
        opt.step()
        score = float(similarity.detach())
        # Every pass draws new flow noise, so one number wobbles by ~0.03.
        # The smoothed value is what decides the winner; the raw one is only
        # there to show that something is happening.
        smooth = score if it == 1 else 0.8 * smooth + 0.2 * score
        if smooth > best_score:
            best_score = smooth
            best_state = (style_ttl.detach().clone(), style_dp.clone())
        left = (deadline - time.time()) / 60
        if it % 5 == 0 or it < 5:
            print(
                f"[{it:4d}] similarity {score:+.3f}  smoothed {smooth:+.3f}  "
                f"best {best_score:+.3f}  {left:.1f} min left",
                flush=True,
            )

    ttl, dp = best_state
    out = work / f"{args.name}.json"
    out.write_text(
        json.dumps(
            {
                "style_ttl": {
                    "dims": [1, 50, 256],
                    "data": ttl.reshape(-1).cpu().tolist(),
                    "type": "float32",
                },
                "style_dp": {
                    "dims": [1, 8, 16],
                    "data": dp.reshape(-1).cpu().tolist(),
                    "type": "float32",
                },
                "metadata": {
                    "source": "clone.py",
                    "from": args.recording.name,
                    "similarity": round(best_score, 4),
                    "iterations": it,
                },
            }
        ),
        "utf-8",
    )
    print(f"\nwrote {out}  (similarity {best_score:+.3f}, {it} iterations)")
    print("Import it: Code Monet → Settings → Voice → Import a voice file")
    if at_quarter is not None and best_score - at_quarter > 0.01:
        print(
            f"\nStill climbing when the time ran out: {at_quarter:+.3f} at three "
            f"quarters, {best_score:+.3f} at the end. Continue from here —\n"
            f"  python clone.py {args.recording} --init-json {out.name} --minutes 60\n"
            f"which is how a +0.673 run became +0.886. Above about +0.87 the "
            f"measurement stops meaning much:\nthe same style spoken twice only "
            f"scores +0.92 against itself."
        )


if __name__ == "__main__":
    main()
