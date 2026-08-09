#!/usr/bin/env python
"""
Invert Supertonic: solve for the style instead of stumbling towards it.

    python inverse.py selftest              # can it recover a voice it knows?
    python inverse.py clone voice.wav --name Sasha

Why this exists. The ten voices shipped with Supertonic 3 were not designed,
they were EXTRACTED — every preset says so in its own metadata:

    {"source_file": "M5.wav", "source_sample_rate": 24000,
     "target_sample_rate": 44100, "extracted_at": "2026-04-28T10:39:39"}

and tts.json still documents an `ae.encoder`, spectrogram settings and all.
Those weights are not in the release: four nets ship, and both halves of the
analysis path — audio to latents, latents to style — are the paid product. The
bundle runs one way only. clone.py works around that with Adam on the style
tensor, and gets a likeness in twenty minutes.

Why not just run Adam for longer. Because the gradient is a bad direction here,
and that is measured rather than suspected. Starting at preset M4 and aiming at
preset F1 — a target whose true answer we hold, so the ceiling is known —
stepping a distance equal to the gap between the two voices gives:

    the exact direction (F1's real style)   0.43 -> 0.889
    the gradient of the loss               0.43 -> 0.393
    a random direction, same length        0.43 -> 0.477

The gradient earns nothing beyond a very short step and then goes backwards.
Style space is 12800-dimensional, the speaker embedding is 192, and the map
between them is so badly conditioned that steepest descent spends its budget on
directions that change nothing audible.

What this does instead. One backward pass per output coordinate gives the whole
Jacobian d(embedding)/d(style) — 192 rows, 2.6 minutes, measured — and then the
step is the Levenberg-Marquardt solution

    dstyle = J^T (J J^T + lambda I)^-1 (target - current)

which is the same information used the other way round: not "which way is
downhill" but "which change in the style produces the change I want in the
voice". lambda is chosen by measuring, every iteration, on a log grid.

HOW IT TURNED OUT, since a docstring that only describes the intention is worse
than none. On the benchmark above, held-out scores after twenty-five minutes:

    adam, fresh flow noise (what clone.py does)   +0.7004   <- the winner
    adam, flow noise fixed                        +0.6725
    lm, the Jacobian solver above                 +0.6368
    span, ten blend weights                       +0.5092

The Jacobian step is twice as effective per unit of distance travelled and about
eighty times more expensive, which is the whole story. Fixing the flow noise, the
other idea here, drove the optimised score to +0.9087 and the honest one to
+0.6725: a 0.24 gap of pure noise-fitting. clone.py, which draws fresh noise every
step and therefore cannot fit any draw, has a gap of 0.004. Use clone.py.

What this file is for, then: the benchmark with a real ceiling, the held-out
column that caught the +0.909 illusion, and a record of four methods so nobody
pays for them twice.

One measurement that stands on its own: XPU is three times SLOWER than CPU on
these graphs (2.81 s vs 0.96 s per utterance), hundreds of tiny ops and all launch
overhead. Default is CPU.

Not done, and deliberately: fitting an audio-to-style regression on styles
sampled around the presets. Random displacements as large as the gap between
two presets leave the speaker embedding inside its own noise floor (0.891 versus
a 0.92 floor), so such a dataset teaches only the blend weights — the voice
mixer that was already tried and removed for guessing wrong every time.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F
import torchaudio

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from clone import (  # noqa: E402
    Supertonic,
    embed_waveform,
    fbank,
    speaker_model,
    widen_converter_registry,
)

# Redirected to a file or a pipe, Python block-buffers stdout and a half-hour
# run shows nothing until it exits — which cost half an hour of not knowing
# whether the first iteration had already answered the question.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)

PRESETS = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"]
TTL_SHAPE = (1, 50, 256)
DP_SHAPE = (1, 8, 16)

# Views: a text and the flow seed it is always spoken with. Two of them, unalike
# in length, so a style cannot win by suiting one sentence.
VIEWS = [
    ("Привет, это проверка голоса на короткой фразе.", 101),
    ("Сегодня я закончил работу раньше и успел немного прогуляться по городу.", 202),
]
# Never used while optimising. The last word on whether the result is real.
HELDOUT = [
    ("Проверяю, как звучит этот голос на длинной фразе с обычными словами.", 909),
    ("Один, два, три, четыре, пять. Кажется, всё работает как надо.", 808),
]


def training_pool(seeds: int) -> list[tuple[str, int]]:
    """The noise draws the optimiser is allowed to see.

    Two of them — one seed per sentence — let 700 Adam steps drive the score to
    +0.909 while the honest, unseen-noise score was +0.673. That is the textbook
    shape of too small a training set, and the textbook fix is a bigger one: the
    same fixed pool, more draws in it."""
    return [(t, s + 1000 * k) for (t, s) in VIEWS for k in range(max(1, seeds))]


def model_dir(given: Path | None) -> Path:
    models = given or (HERE.parent / "tts-models" / "supertonic-3")
    if not (models / "vocoder.onnx").exists():
        sys.exit(
            f"no Supertonic model in {models}\n"
            "install the voice in Code Monet (Settings → Voice) or pass --models"
        )
    return models


def load_style(path: Path, device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
    j = json.loads(path.read_text("utf-8"))
    return (
        torch.tensor(
            np.array(j["style_ttl"]["data"], dtype=np.float32).reshape(TTL_SHAPE),
            device=device,
        ),
        torch.tensor(
            np.array(j["style_dp"]["data"], dtype=np.float32).reshape(DP_SHAPE),
            device=device,
        ),
    )


def write_style(
    path: Path, ttl: torch.Tensor, dp: torch.Tensor, metadata: dict
) -> None:
    path.write_text(
        json.dumps(
            {
                "style_ttl": {
                    "dims": list(TTL_SHAPE),
                    "data": ttl.reshape(-1).detach().cpu().tolist(),
                    "type": "float32",
                },
                "style_dp": {
                    "dims": list(DP_SHAPE),
                    "data": dp.reshape(-1).detach().cpu().tolist(),
                    "type": "float32",
                },
                "metadata": metadata,
            }
        ),
        "utf-8",
    )


class Voice:
    """The model, the speaker net, and one reproducible way to score a style."""

    def __init__(self, models: Path, device: torch.device, steps: int):
        self.device = device
        self.steps = steps
        self.speaker = speaker_model(HERE, device)
        self.tts = Supertonic(models, device, HERE / "cache")

    def embed(self, wav: torch.Tensor) -> torch.Tensor:
        w16 = torchaudio.functional.resample(wav, self.tts.sample_rate, 16000)
        return F.normalize(self.speaker(fbank(w16)), dim=-1)

    def say(
        self,
        ttl: torch.Tensor,
        dp: torch.Tensor,
        views: list[tuple[str, int | None]],
        lang: str = "ru",
    ) -> torch.Tensor:
        """The mean embedding over the views, unit length. Seeded, so calling
        this twice with the same style gives the same answer to the last bit —
        unless a view's seed is None, which is how the fresh-noise comparison
        reproduces what clone.py does."""
        out = []
        for text, seed in views:
            if seed is not None:
                torch.manual_seed(seed)
            out.append(self.embed(self.tts.speak(ttl, dp, text, lang, self.steps)))
        return F.normalize(torch.cat(out).mean(dim=0, keepdim=True), dim=-1)


def jacobian(
    e: torch.Tensor, ttl: torch.Tensor, P: torch.Tensor | None = None
) -> torch.Tensor:
    """d(embedding)/d(style), one backward pass per output coordinate.

    A micro-benchmark said 0.8 s per row, so all 192 should cost 2.6 minutes. In
    the real loop it is 5 to 9: holding one graph across 192 backward passes
    grows the process to 2.7 GB and every row after the first pays for it. Four
    iterations was all a 25-minute budget bought.

    Hence `P`: an orthonormal [rows, 192] projection. Differentiating P·e instead
    of e costs `rows` passes rather than 192 and still inverts the conditioning
    inside that subspace — a randomised block Gauss-Newton, with a fresh
    subspace each iteration so no direction is permanently ignored."""
    flat = e.reshape(-1)
    outputs = flat if P is None else (P @ flat)
    rows = torch.empty(outputs.numel(), ttl.numel(), device=ttl.device)
    for i in range(outputs.numel()):
        (g,) = torch.autograd.grad(
            outputs[i], ttl, retain_graph=True, allow_unused=True
        )
        rows[i] = 0.0 if g is None else g.reshape(-1)
    return rows


def load_bank(models: Path, device: torch.device) -> torch.Tensor:
    """The ten presets stacked: [10, 50, 256]."""
    return torch.cat([load_style(models / f"{v}.json", device)[0] for v in PRESETS])


def solve_span(
    voice: Voice,
    target: torch.Tensor,
    bank: torch.Tensor,
    dp: torch.Tensor,
    iters: int,
    lang: str,
    start: int,
) -> tuple[torch.Tensor, float, list[float]]:
    """Gauss-Newton on ten numbers: the presets' own span, extrapolation allowed.

    Cheap enough to always run (a ten-column Jacobian by finite differences is
    twenty forward passes, twenty seconds) and it answers the question the app's
    voice mixer could not: how much of a real person is reachable by combining
    the ten voices, if the weights are not confined to a convex blend?"""
    c = torch.zeros(len(PRESETS), device=bank.device)
    c[start] = 1.0
    eps = 0.05

    def style(coef: torch.Tensor) -> torch.Tensor:
        return (coef.view(-1, 1, 1) * bank).sum(0, keepdim=True)

    history = []
    with torch.no_grad():
        e = voice.say(style(c), dp, VIEWS, lang)
        score = float(e @ target.T)
        print(f"span start {score:+.4f}  (weights one-hot on {PRESETS[start]})")
        for it in range(1, iters + 1):
            cols = []
            for i in range(len(PRESETS)):
                bump = c.clone()
                bump[i] += eps
                cols.append(
                    ((voice.say(style(bump), dp, VIEWS, lang) - e) / eps).reshape(-1)
                )
            J = torch.stack(cols)  # [10, 192]
            r = (target - e).reshape(-1)
            G = (J @ J.T).double()
            eye = torch.eye(len(PRESETS), dtype=torch.float64, device=G.device)
            scale = float(G.diagonal().mean()) or 1.0
            best = (score, None, None)
            for lam in [10.0**k for k in range(-6, 3)]:
                step = (
                    torch.linalg.solve(G + lam * scale * eye, (J.double() @ r.double()))
                ).float()
                cand = c + step
                got = float(voice.say(style(cand), dp, VIEWS, lang) @ target.T)
                if got > best[0]:
                    best = (got, cand, lam)
            if best[1] is None:
                print("  span: no lambda improved it")
                break
            c, score = best[1], best[0]
            e = voice.say(style(c), dp, VIEWS, lang)
            history.append(score)
            print(
                f"  [{it}] {score:+.4f}  weights sum {float(c.sum()):+.2f}"
                f"  min {float(c.min()):+.2f} max {float(c.max()):+.2f}",
                flush=True,
            )
    return style(c), score, history


def solve_adam(
    voice: Voice,
    target: torch.Tensor,
    ttl0: torch.Tensor,
    dp: torch.Tensor,
    minutes: float,
    lang: str,
    anchor: float,
    lr: float,
    fresh_noise: bool = False,
    seeds: int = 1,
    draws: int = 1,
) -> tuple[torch.Tensor, float, list[float]]:
    """clone.py's method, with one change: the flow noise is fixed.

    Kept here so the comparison is honest. Two things differ between clone.py
    and the solver above — the step direction and the fixed noise — and running
    only the new one would leave it unknown which of them paid. `--fresh-noise`
    is the other arm of that A/B: identical code, seed dropped."""
    ttl = ttl0.clone().requires_grad_(True)
    opt = torch.optim.Adam([ttl], lr=lr)
    deadline = time.time() + minutes * 60
    best = (-2.0, ttl0.clone())
    pool = training_pool(seeds)
    print(f"adam: {len(pool)} noise draws in the pool" + (" (ignored: --fresh-noise)" if fresh_noise else ""))
    it = 0
    while time.time() < deadline:
        it += 1
        text, seed = pool[it % len(pool)]
        # `draws` is the untested middle of the two arms that were measured.
        # Fresh noise is unbiased but every step reads a different objective, and
        # the run visibly wanders once it nears its plateau: +0.714, +0.617,
        # +0.636, +0.682 on consecutive checks. Averaging k independent draws per
        # step keeps the lack of bias and divides the variance by k. Costs k
        # forward passes per step, and NOBODY HAS RUN IT — do not quote a number.
        view = [(text, None if fresh_noise else seed)] * max(1, draws)
        opt.zero_grad(set_to_none=True)
        e = voice.say(ttl, dp, view, lang)
        cos = (e @ target.T).reshape(())
        (1.0 - cos + anchor * ((ttl - ttl0) ** 2).mean() / 1e-4).backward()
        opt.step()
        if it % 25 == 0:
            with torch.no_grad():
                full = float(voice.say(ttl, dp, VIEWS, lang) @ target.T)
            if full > best[0]:
                best = (full, ttl.detach().clone())
            print(
                f"[{it:4d}] both views {full:+.4f}  best {best[0]:+.4f}"
                f"  {(deadline - time.time())/60:.0f} min left",
                flush=True,
            )
    return best[1], best[0], []


def solve_lm(
    voice: Voice,
    target: torch.Tensor,
    ttl0: torch.Tensor,
    dp: torch.Tensor,
    iters: int,
    minutes: float,
    lang: str,
    anchor: float,
    rows: int,
) -> tuple[torch.Tensor, float, list[float]]:
    """Levenberg-Marquardt on the style, with the step length measured."""
    ttl = ttl0.clone()
    with torch.no_grad():
        score = float(voice.say(ttl, dp, VIEWS, lang) @ target.T)
    print(f"start {score:+.4f}")
    history = [score]
    deadline = time.time() + minutes * 60
    # lambda spans nine decades because the right one is not guessable: it
    # depends on the Jacobian's scale at the current point, which changes.
    grid = [10.0**k for k in range(-6, 3)]
    for it in range(1, iters + 1):
        if time.time() > deadline:
            print("out of time")
            break
        live = ttl.clone().requires_grad_(True)
        # One view for the Jacobian, alternating — 192 backward passes through
        # two graphs would double the only expensive part of the iteration.
        view = [VIEWS[(it - 1) % len(VIEWS)]]
        e = voice.say(live, dp, view, lang)
        t0 = time.time()
        # A fresh subspace every iteration, orthonormal by QR so the projection
        # neither stretches nor collapses the residual it is asked to explain.
        P = None
        if rows and rows < e.numel():
            P = torch.linalg.qr(torch.randn(e.numel(), rows, device=e.device))[0].T
        J = jacobian(e, live, P)
        r = (target - e).reshape(-1).detach()
        if P is not None:
            r = P @ r
        G = (J @ J.T).double()
        s = torch.linalg.svdvals(G).clamp_min(1e-30).sqrt()
        # The normalised embedding lives on a sphere, so J has no radial
        # component and G is singular by construction — the damping is not a
        # nicety here, it is what makes the system solvable at all.
        eye = torch.eye(G.shape[0], dtype=torch.float64, device=G.device)
        scale = float(G.diagonal().mean())
        print(
            f"[{it}] jacobian {J.shape[0]} rows in {time.time()-t0:.0f} s  "
            f"singular values {float(s[0]):.3g} … {float(s[-1]):.3g}"
            f"  (condition {float(s[0]/s[-1]):.3g})",
            flush=True,
        )
        Jd = J.double()
        rd = r.double()
        # The anchor is the same idea as clone.py's: a style far from anything
        # the model has seen may score well and sound wrong. Charged to the
        # incumbent too, or the first iteration wins by default.
        def penalty_of(style: torch.Tensor) -> float:
            return anchor * float(((style - ttl0) ** 2).mean()) / 1e-4

        best = (score - penalty_of(ttl), None, None)
        with torch.no_grad():
            for lam in grid:
                delta = (
                    Jd.T @ torch.linalg.solve(G + lam * scale * eye, rd)
                ).float().reshape(TTL_SHAPE)
                cand = ttl + delta
                got = float(voice.say(cand, dp, VIEWS, lang) @ target.T)
                penalty = penalty_of(cand)
                if got - penalty > best[0]:
                    best = (got - penalty, cand, (lam, got, float(delta.norm())))
        if best[1] is None:
            print("  no lambda improved it — stopping")
            break
        lam, got, dn = best[2]
        ttl, score = best[1], got
        history.append(score)
        print(f"  lambda {lam:g}  step {dn:.3f}  ->  {score:+.4f}", flush=True)
        # Centre the next grid on what just worked; nine decades every time is
        # eight wasted forward passes.
        grid = [lam * 10.0**k for k in (-1.5, -1, -0.5, 0, 0.5, 1, 1.5)]
    return ttl, score, history


# ── Learning the encoder Supertonic kept ────────────────────────────────
#
# Both optimisers crawl for the same reason: around any one voice the objective
# is a plateau, and almost all of the payoff sits next to the true answer. Along
# the straight line from M4 to F1 the score goes 0.43, 0.45, 0.49, 0.60, 0.889 —
# monotone, but convex, so a local method reads the flat end and inches.
#
# A regression does not have to walk that line. Fit "embedding -> where in the
# span" on samples drawn across the whole span and the answer is one matrix
# multiply, plateau or no plateau.
#
# The distribution is what matters, and it is where the first plan was wrong.
# RANDOM displacements of the style leave the embedding inside its own noise
# floor, so a dataset of random styles teaches nothing. Displacements along
# PRESET DIFFERENCES move it all the way from 0.43 to 0.889. So every sample here
# is an affine combination of the ten presets — coefficients summing to one,
# allowed outside the simplex, which is the part a convex blender cannot reach.


def sample_coefficients(rng: np.random.Generator) -> np.ndarray:
    """Anchored on a real voice, aimed at another, and allowed to overshoot.

    c = e_j + s (w - e_j): a one-hot on preset j, pulled towards a random convex
    blend w by s. s in [0,1] interpolates, s > 1 overshoots past the blend, s < 0
    walks the other way. Any such c sums to one, so the style keeps the
    magnitude the model expects."""
    n = len(PRESETS)
    j = int(rng.integers(n))
    k = int(rng.integers(1, 4))
    which = rng.choice(n, size=k, replace=False)
    w = np.zeros(n, dtype=np.float64)
    w[which] = rng.dirichlet(np.full(k, 0.7))
    e = np.zeros(n, dtype=np.float64)
    e[j] = 1.0
    s = float(rng.uniform(-0.5, 1.9))
    return (e + s * (w - e)).astype(np.float32)


def cmd_learn(args: argparse.Namespace) -> None:
    device = torch.device(args.device)
    models = model_dir(args.models)
    voice = Voice(models, device, args.steps)
    bank = load_bank(models, device)
    rng = np.random.default_rng(4242)
    store = args.out or (HERE / "inverse.npz")

    def style(c: np.ndarray) -> torch.Tensor:
        return (
            torch.tensor(c, device=device).view(-1, 1, 1) * bank
        ).sum(0, keepdim=True)

    dp0 = load_style(models / "M4.json", device)[1]

    # Resume: a twenty-minute generate that starts over on Ctrl-C is a
    # twenty-minute generate nobody interrupts to look at.
    C, E = [], []
    if store.exists():
        old = np.load(store)
        if "coef" in old:
            C, E = list(old["coef"]), list(old["emb"])
            print(f"resuming with {len(C)} pairs already generated")

    t0 = time.time()
    dropped = 0
    while len(C) < args.pairs:
        c = sample_coefficients(rng)
        with torch.no_grad():
            st = style(c)
            views, ok = [], True
            for text, seed in VIEWS:
                torch.manual_seed(seed)
                wav = voice.tts.speak(st, dp0, text, args.lang, args.steps)
                rms = float(wav.pow(2).mean().sqrt())
                if not (0.005 < rms < 1.5):
                    ok = False
                    break
                views.append(voice.embed(wav).reshape(-1).cpu().numpy())
        # An overshoot far enough out can silence the model or clip it. Teaching
        # the fit about a region the synthesiser cannot speak in would be worse
        # than not having the sample.
        if not ok:
            dropped += 1
            continue
        C.append(c)
        E.append(np.stack(views))
        if len(C) % 20 == 0:
            np.savez_compressed(store, coef=np.stack(C), emb=np.stack(E))
            print(
                f"  {len(C)}/{args.pairs}  {(time.time()-t0)/len(C):.2f} s/pair"
                f"  {(args.pairs-len(C))*(time.time()-t0)/len(C)/60:.0f} min left"
                f"  (dropped {dropped})",
                flush=True,
            )
    coef = np.stack(C)
    emb = np.stack(E)
    np.savez_compressed(store, coef=coef, emb=emb)
    print(f"{len(coef)} pairs, dropped {dropped}, {(time.time()-t0)/60:.0f} min")

    # ── the fit ─────────────────────────────────────────────────────────
    def design(e3: np.ndarray) -> np.ndarray:
        """Views become rows, and their mean becomes one more: `apply` feeds an
        average over windows of a real recording, so the fit must have seen an
        average."""
        mean = e3.mean(axis=1, keepdims=True)
        mean /= np.linalg.norm(mean, axis=-1, keepdims=True)
        allv = np.concatenate([e3, mean], axis=1)
        n, v, d = allv.shape
        flat = allv.reshape(n * v, d)
        return np.concatenate(
            [np.ones((n * v, 1), dtype=np.float32), flat], axis=1
        ).reshape(n, v, d + 1)

    D = design(emb).astype(np.float64)
    Y = coef.astype(np.float64)

    def ridge(mask: np.ndarray, lam: float) -> np.ndarray:
        X = D[mask].reshape(-1, D.shape[-1])
        T = np.repeat(Y[mask], D.shape[1], axis=0)
        A = X.T @ X + lam * np.eye(X.shape[1])
        A[0, 0] -= lam  # the bias carries the mean style; never shrink it
        return np.linalg.solve(A, X.T @ T)

    print("\nleave one preset out: fit without a single sample that touches it,")
    print("then rebuild that voice from its own audio. A voice never seen.")
    lams = [float(x) for x in args.lam.split(",")]
    scores = {l: [] for l in lams}
    with torch.no_grad():
        for i, vid in enumerate(PRESETS):
            ttl_p, dp_p = load_style(models / f"{vid}.json", device)
            target = voice.say(ttl_p, dp0, VIEWS, args.lang)
            t = target.reshape(-1).cpu().numpy()
            x = np.concatenate([[1.0], t]).astype(np.float64)
            mask = np.abs(coef[:, i]) < 1e-6
            line = f"  {vid} (fit on {int(mask.sum())})"
            for lam in lams:
                c = x @ ridge(mask, lam)
                got = voice.say(style(c.astype(np.float32)), dp0, VIEWS, args.lang)
                cos = float(got @ target.T)
                scores[lam].append(cos)
                line += f"   λ{lam:g} {cos:+.3f}"
            print(line + f"   [true c_{vid} would give +1.000]", flush=True)
    print("\n  mean over the ten:")
    for lam in lams:
        print(f"    λ{lam:g}: {np.mean(scores[lam]):+.3f}")
    best_lam = max(lams, key=lambda l: float(np.mean(scores[l])))
    W = ridge(np.ones(len(Y), dtype=bool), best_lam)
    np.savez_compressed(
        store,
        coef=coef,
        emb=emb,
        W=W.astype(np.float32),
        lam=np.float32(best_lam),
        loo=np.array(scores[best_lam], dtype=np.float32),
    )
    print(
        f"\nwrote {store}  (λ={best_lam:g}, unseen voices rebuilt at "
        f"{np.mean(scores[best_lam]):+.3f} from {len(coef)} pairs)"
    )


def cmd_apply(args: argparse.Namespace) -> None:
    device = torch.device(args.device)
    models = model_dir(args.models)
    store = args.inverse or (HERE / "inverse.npz")
    if not store.exists():
        sys.exit(f"no fitted encoder at {store} — run `inverse.py learn` first")
    data = np.load(store)
    if "W" not in data:
        sys.exit(f"{store} has pairs but no fit — `inverse.py learn` was interrupted")
    W = data["W"].astype(np.float64)
    voice = Voice(models, device, args.steps)
    bank = load_bank(models, device)
    dp0 = load_style(models / "M4.json", device)[1]

    target, seconds, windows = recording_target(args.recording, voice, device)
    c = (np.concatenate([[1.0], target.reshape(-1).cpu().numpy()]) @ W).astype(np.float32)
    ttl = (torch.tensor(c, device=device).view(-1, 1, 1) * bank).sum(0, keepdim=True)
    with torch.no_grad():
        fixed = float(voice.say(ttl, dp0, VIEWS, args.lang) @ target.T)
        held = float(voice.say(ttl, dp0, HELDOUT, args.lang) @ target.T)
    print(f"\ncoefficients: " + "  ".join(f"{v}{c[i]:+.2f}" for i, v in enumerate(PRESETS)))
    print(f"similarity {fixed:+.4f}   held-out views {held:+.4f}   (one matrix multiply)")
    out = HERE / f"{args.name}.json"
    write_style(
        out,
        ttl,
        dp0,
        {
            "source": "inverse.py apply",
            "from": args.recording.name,
            "similarity": round(fixed, 4),
            "held_out": round(held, 4),
            "unseen_voices_rebuilt_at": round(float(np.mean(data["loo"])), 4),
            "coefficients": {v: round(float(c[i]), 4) for i, v in enumerate(PRESETS)},
        },
    )
    print(f"wrote {out}")
    print(f"To push further: python inverse.py clone {args.recording} --init-json {out.name}")


def recording_target(
    path: Path, voice: Voice, device: torch.device
) -> tuple[torch.Tensor, float, int]:
    audio, rate = sf.read(str(path), dtype="float32", always_2d=True)
    mono = torch.tensor(audio.mean(axis=1), device=device)
    if mono.numel() < rate * 3:
        sys.exit("that clip is under three seconds — record 20-40 s of speech")
    window = min(int(4.0 * rate), mono.numel())
    hop = max(1, (mono.numel() - window) // 5)
    with torch.no_grad():
        embs = [
            F.normalize(embed_waveform(mono[p : p + window], rate, voice.speaker), dim=-1)
            for p in range(0, mono.numel() - window + 1, hop)
        ][:6]
    target = F.normalize(torch.cat(embs).mean(dim=0, keepdim=True), dim=-1)
    steady = float((torch.cat(embs) @ target.reshape(-1, 1)).mean())
    print(
        f"target from {mono.numel()/rate:.0f} s, {len(embs)} windows "
        f"(each {steady:+.3f} to their mean — under +0.8 means the recording is "
        f"not one steady voice)"
    )
    return target, mono.numel() / rate, len(embs)


def solve(
    voice: Voice,
    target: torch.Tensor,
    ttl0: torch.Tensor,
    dp: torch.Tensor,
    args: argparse.Namespace,
    lang: str,
    models: Path,
    start_name: str,
) -> tuple[torch.Tensor, float, list[float]]:
    if args.method == "span":
        return solve_span(
            voice,
            target,
            load_bank(models, ttl0.device),
            dp,
            args.iters,
            lang,
            PRESETS.index(start_name),
        )
    if args.method == "adam":
        return solve_adam(
            voice,
            target,
            ttl0,
            dp,
            args.minutes,
            lang,
            args.anchor,
            args.lr,
            args.fresh_noise,
            args.seeds,
            args.draws,
        )
    return solve_lm(
        voice, target, ttl0, dp, args.iters, args.minutes, lang, args.anchor, args.rows
    )


def report(voice: Voice, ttl, dp, target, lang: str) -> tuple[float, float]:
    """Fixed noise is how it was optimised; fresh noise is whether it is true."""
    with torch.no_grad():
        fixed = float(voice.say(ttl, dp, VIEWS, lang) @ target.T)
        held = float(voice.say(ttl, dp, HELDOUT, lang) @ target.T)
    print(f"\n  optimised views {fixed:+.4f}     held-out views {held:+.4f}")
    return fixed, held


def cmd_selftest(args: argparse.Namespace) -> None:
    """The only test with a known right answer: recover one preset from another.

    A method that cannot rebuild a voice the model itself can produce has no
    business being pointed at a real person."""
    device = torch.device(args.device)
    models = model_dir(args.models)
    voice = Voice(models, device, args.steps)
    src_ttl, src_dp = load_style(models / f"{args.start}.json", device)
    tgt_ttl, tgt_dp = load_style(models / f"{args.target}.json", device)

    with torch.no_grad():
        target = voice.say(tgt_ttl, tgt_dp, VIEWS)
        # What the true style scores — measured, not assumed to be 1.0. Two
        # things hold it down and both had to be measured separately: the rhythm
        # tensor stays the source's (worth 0.06), and on unseen flow noise even
        # the exact answer only scores about 0.92. Reporting a held-out number
        # against a ceiling of 1.0 flattered every method here by a wide margin.
        ceiling = float(voice.say(tgt_ttl, src_dp, VIEWS) @ target.T)
        floor = float(voice.say(src_ttl, src_dp, VIEWS) @ target.T)
        ceiling_held = float(voice.say(tgt_ttl, src_dp, HELDOUT) @ target.T)
        floor_held = float(voice.say(src_ttl, src_dp, HELDOUT) @ target.T)
    print(f"\ntarget {args.target}, starting from {args.start}")
    print(f"                        optimised   held-out")
    print(f"  the true {args.target} style   {ceiling:+.4f}    {ceiling_held:+.4f}  <- ceiling")
    print(f"  {args.start} as it is        {floor:+.4f}    {floor_held:+.4f}  <- floor\n")

    ttl, score, _ = solve(
        voice, target, src_ttl, src_dp, args, "ru", models, args.start
    )
    fixed, held = report(voice, ttl, src_dp, target, "ru")
    print(
        f"  closed {(fixed - floor) / (ceiling - floor) * 100:.0f}% of the gap on the "
        f"views it optimised ({floor:+.3f} → {fixed:+.3f} of {ceiling:+.3f})"
    )
    # The only one worth quoting. A method can drive the optimised views to the
    # ceiling by fitting two particular draws of flow noise, and one here did:
    # +0.909 optimised against +0.673 held out.
    print(
        f"  closed {(held - floor_held) / (ceiling_held - floor_held) * 100:.0f}% of the gap "
        f"on views it never saw ({floor_held:+.3f} → {held:+.3f} of {ceiling_held:+.3f})"
    )
    if args.out:
        write_style(
            args.out,
            ttl,
            src_dp,
            {
                "source": "inverse.py selftest",
                "target": args.target,
                "start": args.start,
                "similarity": round(fixed, 4),
                "held_out": round(held, 4),
                "ceiling": round(ceiling, 4),
            },
        )
        print(f"  wrote {args.out}")


def cmd_clone(args: argparse.Namespace) -> None:
    device = torch.device(args.device)
    models = model_dir(args.models)
    voice = Voice(models, device, args.steps)

    target, _, _ = recording_target(args.recording, voice, device)
    nearest = PRESETS[0]
    if args.init_json:
        start = args.init_json
        ttl0, dp0 = load_style(start, device)
        print(f"starting from {start}")
    else:
        print("\nscoring the presets…")
        scored = {}
        with torch.no_grad():
            for vid in PRESETS:
                ttl, dp = load_style(models / f"{vid}.json", device)
                scored[vid] = (float(voice.say(ttl, dp, VIEWS) @ target.T), ttl, dp)
                print(f"  {vid}: {scored[vid][0]:+.3f}", flush=True)
        best = max(scored, key=lambda k: scored[k][0])
        vals = [v[0] for v in scored.values()]
        males = [scored[k][0] for k in scored if k.startswith("M")]
        females = [scored[k][0] for k in scored if k.startswith("F")]
        print(
            f"spread across the ten: {max(vals)-min(vals):.3f}"
            f"  (male-female gap {sum(males)/5 - sum(females)/5:+.3f})"
        )
        if max(vals) - min(vals) < 0.02:
            sys.exit("the objective cannot tell these ten apart — check the recording")
        _, ttl0, dp0 = scored[best]
        nearest = best
        print(f"starting from {best} ({scored[best][0]:+.3f})")

    ttl, score, _ = solve(
        voice, target, ttl0, dp0, args, args.lang, models, nearest
    )
    fixed, held = report(voice, ttl, dp0, target, args.lang)
    out = HERE / f"{args.name}.json"
    write_style(
        out,
        ttl,
        dp0,
        {
            "source": "inverse.py",
            "from": args.recording.name,
            "similarity": round(fixed, 4),
            "held_out": round(held, 4),
        },
    )
    if args.wav:
        with torch.no_grad():
            torch.manual_seed(HELDOUT[0][1])
            wav = voice.tts.speak(ttl, dp0, HELDOUT[0][0], args.lang, args.steps)
        sf.write(str(args.wav), wav.cpu().numpy(), voice.tts.sample_rate)
        print(f"  wrote {args.wav}")
    print(f"\nwrote {out}")
    print("Import it: Code Monet → Settings → Voice → Import a voice file")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--models", type=Path, default=None)
    # Not "auto": XPU is slower here, and picking it automatically would make
    # the tool look broken on exactly the machines that have one.
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda", "xpu"])
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--iters", type=int, default=8)
    ap.add_argument("--minutes", type=float, default=30.0)
    ap.add_argument("--anchor", type=float, default=0.0, help="pull towards the start")
    ap.add_argument(
        "--method",
        default="lm",
        choices=["lm", "adam", "span"],
        help="lm solves with the full Jacobian; span solves for ten blend "
        "weights only (seconds, extrapolation allowed); adam is clone.py's "
        "descent with the flow noise fixed. All three on the same task, so the "
        "numbers can be compared rather than argued about",
    )
    ap.add_argument("--lr", type=float, default=1e-3, help="--method adam only")
    ap.add_argument(
        "--seeds",
        type=int,
        default=1,
        help="--method adam: fixed flow-noise draws per sentence. 1 is what "
        "overfitted (+0.909 optimised, +0.673 honest); more should close that gap",
    )
    ap.add_argument(
        "--draws",
        type=int,
        default=1,
        help="--method adam: average this many noise draws per step. Lowers the "
        "gradient's variance without fitting any one draw. UNTESTED",
    )
    ap.add_argument(
        "--fresh-noise",
        action="store_true",
        help="--method adam: draw new flow noise every step, as clone.py does. "
        "The control arm — it is how the fixed-noise result was attributed",
    )
    ap.add_argument(
        "--rows",
        type=int,
        default=32,
        help="--method lm: how many of the 192 embedding coordinates to "
        "differentiate per iteration. All 192 costs 5-9 minutes and bought four "
        "iterations in twenty-five; 32 buys about twenty. 0 means all of them",
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("selftest", help="recover one preset starting from another")
    s.add_argument("--start", default="M4", choices=PRESETS)
    s.add_argument("--target", default="F1", choices=PRESETS)
    s.add_argument("--out", type=Path, default=None)

    c = sub.add_parser("clone", help="a recording in, a style file out (slow)")
    c.add_argument("recording", type=Path)
    c.add_argument("--name", default="my-voice")
    c.add_argument("--lang", default="ru")
    c.add_argument("--init-json", type=Path, default=None)
    c.add_argument("--wav", type=Path, default=None, help="also write a sample")

    n = sub.add_parser("learn", help="build the encoder: generate pairs, fit, score")
    n.add_argument("--pairs", type=int, default=400)
    n.add_argument("--lam", default="1e-6,1e-4,1e-2,1e0", help="ridge values to try")
    n.add_argument("--lang", default="ru")
    n.add_argument("--out", type=Path, default=None)

    a = sub.add_parser("apply", help="a recording in, a style file out (instant)")
    a.add_argument("recording", type=Path)
    a.add_argument("--name", default="my-voice")
    a.add_argument("--inverse", type=Path, default=None)
    a.add_argument("--lang", default="ru")

    args = ap.parse_args()
    widen_converter_registry()
    {
        "selftest": cmd_selftest,
        "clone": cmd_clone,
        "learn": cmd_learn,
        "apply": cmd_apply,
    }[args.cmd](args)


if __name__ == "__main__":
    main()
