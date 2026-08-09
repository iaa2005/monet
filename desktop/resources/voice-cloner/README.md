# Clone your voice for Code Monet

This folder turns a recording of your voice into a **Supertonic 3 style file** —
the 0.3 MB JSON the app imports in *Settings → Voice → Import a voice file*.

```bash
pip install -r requirements.txt
python clone.py voice.wav --name Sasha --minutes 20
```

`voice.wav` is already here if the app recorded it for you. The result is
`Sasha.json` next to this README.

**`clone.py` is still the one to run.** `inverse.py` next to it holds three other
methods, a benchmark with a known right answer, and the measurements that decided
between them — including several that were tried and lost. Everything below is
measured on this pipeline; nothing in it is an expectation.

## What it actually does

Supertonic's voice is two tensors. Nothing published turns audio into them
directly — there is no style *encoder* — so this program treats them as the only
unknowns and optimises them:

```
style → text encoder → flow matching → vocoder → waveform
                                                    ↓
            loss = 1 − cosine( CAM++(it), CAM++(your recording) )
```

**One loss, and a WavLM one that was tried and dropped.** The obvious upgrade —
[kdrkdrkdr/supertonic.embed][embed] uses WavLM layer-4 features, which are still
low-level and should carry more of a voice than an identity vector — does not
survive the adaptation this tool needs. Their target's text is known, so they can
compare features frame by frame; here the target says different words, so the
features have to be pooled, and pooled layer-4 statistics turn out to encode
"this is speech at this level" and almost nothing about who is speaking.

Measured on a 19-second Russian recording, scoring the ten presets:

| objective | spread across the ten | male − female | winner |
| --- | --- | --- | --- |
| WavLM L4 statistics, raw | **0.007** | −0.001 | noise |
| WavLM L4 statistics, centred on the presets' mean | 0.175 | +0.028 | M4 |
| CAM++ speaker cosine | 0.181 | **+0.078** | M4 |

Raw, it cannot tell a female voice from a male one — and a fifteen-minute run
confirmed it: the WavLM number sat at 0.97 from the first iteration while the
speaker similarity fell from 0.58 to 0.37. Centring rescues the spread (the same
trick the voice map needed) and it then agrees with CAM++ on the winner, but it
separates genders three times worse for 377 MB and twice the time per iteration.
So: CAM++, and the preset scoring now prints the spread, which is the diagnostic
that made this decision cost a minute instead of an evening.

[embed]: https://github.com/kdrkdrkdr/supertonic.embed

Every arrow is differentiable once the ONNX graphs are converted to PyTorch, so
this is gradient descent on the voice itself rather than a search among the ten
presets. (The app tried the search; blending presets pulls towards the *average*
voice and a real person is nowhere near it.)

Also
[Fawzan09/voice-builder-for-supertonic-3](https://github.com/Fawzan09/voice-builder-for-supertonic-3),
which optimises against SpeechBrain's ECAPA-TDNN.

## `inverse.py` — the other methods, and how they lost

```bash
python inverse.py selftest --method adam   # the benchmark, with a real ceiling
python inverse.py selftest --method lm     # the Jacobian solver
python inverse.py selftest --method span   # ten blend weights, extrapolating
python inverse.py learn --pairs 400        # fit audio → style, ~20 min
python inverse.py apply voice.wav          # then clone in milliseconds
```

`selftest` is the part worth keeping whatever wins: recover preset F1 starting
from preset M4. The right answer is a file on disk, so the ceiling is measurable
rather than assumed, and it is measured twice — on the sentences and flow-noise
draws the optimiser saw, and on ones it never did.

| | optimised views | **held out** |
| --- | --- | --- |
| the true F1 style — the ceiling | +0.9416 | **+0.9153** |
| M4 as it is — the floor | +0.4484 | +0.4349 |
| `span`, 10 weights, 8 min | +0.4819 | +0.5092 |
| `lm`, full Jacobian, 4 iterations, 25 min | +0.6802 | +0.6368 |
| `adam` with the flow noise **fixed**, 700 iterations, 25 min | +0.9087 | +0.6725 |
| `adam` with the flow noise **fresh** — `clone.py`'s old method | +0.7136 | +0.7004 |
| `adam`, fresh noise, **4 draws averaged per step** | +0.7489 | **+0.7105** |

The bottom two rows are why the held-out column exists, and they are the result of
the whole exercise. Fixing the flow noise makes the objective exactly reproducible
and the score climbs to +0.909, of which **+0.24 is the optimiser learning two
particular draws of noise** rather than a voice. Drawing fresh noise every step
looks worse the whole way — it plateaus at +0.71 and visibly wanders, +0.714,
+0.617, +0.636, +0.682 on consecutive checks — and ends up better where it counts,
with a held-out gap of 0.013 against 0.236.

So `clone.py`'s original design beat every method built to replace it: +0.700
against +0.673, +0.637 and +0.509. Worth writing down precisely because it is not
what any of the reasoning predicted.

**The one improvement that survived contact was the smallest.** `--draws 4`
averages four fresh renderings per step: unbiased like fresh noise, with the
variance divided by two. The honest scores are +0.7105 against +0.7004, which on
its own is inside the noise of a single pair of runs. The reason it is now the
default is the shape of the two curves:

| minutes in | 1 draw | 4 draws |
| --- | --- | --- |
| ~4 | +0.562 | +0.614 |
| ~14 | +0.714 | +0.725 |
| ~25 (end) | +0.682, best still +0.714 | **+0.749, still climbing** |

One draw reaches its plateau at fourteen minutes and spends the remaining eleven
wandering — +0.714, +0.617, +0.636, +0.682 on consecutive checks, which is the
gradient chasing a different objective every step. Four draws never wobbles and
had not finished climbing when the budget ran out. Whether 2 or 8 is better than 4
has not been measured.

Note also that the held-out ceiling is **+0.9153, not 1.0**: even the exact answer
loses 0.085 to an unseen noise draw and nothing at all to unseen sentences
(+0.9162 with the same texts and different seeds). Any number here quoted against
1.0 flatters itself.

## Why the gradient is the wrong direction

`inverse.py` exists because of one measurement. Start at preset M4, aim at preset
F1 — a target whose true answer we hold, so the ceiling is known — and step a
distance equal to the gap between the two voices (‖F1 − M4‖ = 2.77):

| direction, one voice-length | cos to F1 (start +0.43) |
| --- | --- |
| the exact one (F1's real style) | **+0.889** |
| the gradient of the loss | +0.393 |
| a random direction | +0.477 |
| a low-rank random direction | +0.431 |

The target is reachable. The gradient earns +0.07 at a tenth of that distance,
+0.07 at half of it, and goes *backwards* at full length — worse than random.
Style space has 12800 dimensions, the speaker embedding has 192, and the map
between them is conditioned badly enough that steepest descent spends its budget
on changes nothing can hear. That is the whole story of `clone.py`'s 273
iterations for +0.33.

`inverse.py --method lm` computes the entire Jacobian d(embedding)/d(style)
instead — 192 backward passes — and steps with

```
dstyle = Jᵀ (J Jᵀ + λI)⁻¹ (target − current)
```

which asks the useful question: not *which way is downhill* but *which change to
the style produces the change I want in the voice*. λ is picked by measuring, on
a log grid, every iteration. The condition number it reports is 2·10⁵ to 2·10⁶,
so the diagnosis was right.

**The cure was not.** A micro-benchmark said 0.8 s per Jacobian row, so 2.6
minutes for all 192; in the real loop it is 5 to 9, because holding one graph
across 192 backward passes grows the process to 2.7 GB. Four iterations was all a
twenty-five-minute budget bought, for +0.637 on unseen views — *below* plain
descent's +0.673. `--rows 32` projects the Jacobian onto a fresh random subspace
each iteration to buy about twenty iterations instead of four; the honest note is
that this has not been run to completion yet, so nothing here claims it wins.

Two more measurements are baked in:

- **The flow noise is fixed.** The sampler draws fresh noise per utterance, and
  the same style spoken twice scores only **+0.92** against itself. With the seed
  held, it scores +1.0000 exactly. So every view has a fixed seed (common random
  numbers), and the result is re-checked on *unseen* seeds and sentences at the
  end — the `held-out views` column. A fixed-noise number alone would be a
  fluke waiting to be believed.
- **XPU is three times slower than CPU** here: 2.81 s versus 0.96 s per
  utterance. Hundreds of tiny operations, all launch overhead. `--device` does
  not default to `auto` for that reason.

## The plateau, and why any local method crawls

Both optimisers are slow for one reason, and `--method span` is what showed it.
That mode solves for only ten numbers — the blend weights, extrapolation allowed
— on the M4 → F1 task, where the answer *is inside its search space*: weight 1.0
on F1, worth +0.9416. It reached **+0.482** and then stopped, because no step
length improved anything.

Ten dimensions, the answer in the set, and Gauss-Newton stalls. The reason is the
shape of the objective along the straight line from M4 to F1:

| distance travelled | 0 | 0.1 | 0.25 | 0.5 | 1.0 |
| --- | --- | --- | --- | --- | --- |
| cos to F1 | +0.430 | +0.452 | +0.489 | +0.601 | **+0.889** |

Monotone, but convex: nearly flat where you start and steep only near the answer.
Around any one voice the objective is a plateau, and every local method — Adam,
Levenberg-Marquardt, coordinate search — reads that plateau and inches. It is not
a conditioning problem that a better step fixes; the information is simply not
present until you are almost there.

## Learning the encoder instead — `inverse.py learn`

A regression does not have to walk the plateau. Fit *embedding → where in the
span* on samples drawn across the whole space, and the answer is one matrix
multiply from a recording.

The distribution is the entire trick, and the first attempt at it was wrong.
Sampling **random** displacements of the style teaches nothing: a random step as
large as the gap between two presets leaves the embedding at +0.891 against a
+0.92 noise floor — it does not move, so there is nothing to regress on. Sampling
along **preset differences** moves it the whole way, +0.43 to +0.889, as the table
above shows. So every training sample is an affine combination of the ten presets,

```
c = e_j + s (w − e_j)      s ∈ [−0.5, 1.9]
```

anchored on a real voice `e_j`, aimed at a random convex blend `w`, and allowed
to overshoot — `s > 1` is the part a convex blender can never reach. The
coefficients sum to one, so the style keeps the magnitude the model expects, and
any sample whose audio comes out silent or clipped is thrown away rather than
taught. (Of 400 samples at those settings, none had to be: the synthesiser speaks
happily well outside the simplex.)

The test is leave-one-preset-out: fit without a single sample that touches preset
P, then rebuild P from its own audio. A voice the fit has never been shown, with
a known right answer. 400 pairs, nine minutes to generate, and it works:

| held out | F1 | F2 | F3 | F4 | F5 | M1 | M2 | M3 | M4 | M5 | mean |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rebuilt at | .86 | .76 | .89 | .74 | .87 | .65 | .81 | .76 | .62 | .74 | **+0.770** |

Ten voices, each reconstructed from its own audio by a fit that never saw it, in
milliseconds. That is better than any optimiser here manages in twenty-five
minutes — on the honest column: Adam +0.673, Levenberg-Marquardt +0.637.

**And it is worth +0.18 on a real person.** Which is the whole lesson, below.

## The ceiling, measured

Those 400 synthesised voices are a sample of everything the model can be made to
say inside the presets' span. Scored against a real 19-second recording, alongside
what descent reaches outside it. The right-hand column uses three sentences and
three flow-noise seeds that nothing in the run had ever spoken:

| | familiar | **unseen** |
| --- | --- | --- |
| the best plain preset (M4) | +0.2667 | +0.2931 |
| the fitted encoder's one matrix multiply | +0.1783 | +0.1607 |
| the best of 400 voices across the whole span | +0.3815 | — |
| `clone.py`, 12 minutes | +0.6677 | +0.6683 |
| `clone.py`, 45 minutes more from that style | **+0.8860** | **+0.8675** |
| — for scale: a synthetic voice to its nearest synthetic neighbour | +0.9547 | |
| — for scale: two synthetic voices at random | +0.5061 | |
| — for scale: the same style spoken twice, different flow noise | +0.92 | |

**+0.868 on a real voice, verified on sentences it never saw** (+0.817, +0.807,
+0.815 individually — a spread of 0.01, so there is no text-fitting in it). That is
94% of the model's own reproducibility, and it took no new method: the earlier
+0.667 was the end of a twelve-minute budget, not the end of the descent.

Run it long. `--minutes 60` is a reasonable default for a voice you care about.

**Keep the anchor on.** That 45-minute run was `--anchor 0`, and past iteration
~700 it came apart: the smoothed score fell from +0.857 to +0.699 by iteration
1100 as the style drifted off anything the model knows. Only the kept best state
saved the result. The 0.02 default exists for exactly that.

Read together, those numbers settle several arguments:

- **The span is a dead end for a real person.** Unconstrained extrapolation beats
  the best preset (+0.38 against +0.27, so the blender was leaving something on
  the table) but not by much, and no amount of extra training pairs moves that
  ceiling. An encoder fitted on the span cannot exceed +0.38 however well it
  fits. Its +0.770 on synthetic voices was real and its +0.18 on a real voice is
  the domain gap, not a bug.
- **Descent earns its twenty minutes.** +0.6677 is nearly twice the span's
  ceiling; the directions that carry a real voice are off the span entirely, and
  gradient descent is so far the only thing here that finds them.
- **`clone.py`'s number was honest all along**: +0.6677 optimised against +0.6633
  on unseen sentences and unseen flow noise — a gap of 0.004, because it draws
  fresh noise every step and so can never fit any particular draw.
- **+0.9 is the wall, and it is close.** The same style spoken twice scores +0.92
  against itself; two *different* voices score +0.5. So +0.92 is not a score to
  beat, it is the noise in the ruler. A 45-minute descent reached +0.868 on unseen
  sentences, which leaves almost nothing between the result and the measurement's
  own floor. Past that point the metric stops being able to tell you anything, and
  the question becomes whether it sounds right rather than what it scores.

## What to expect

Measured on this pipeline (CPU, one core-heavy iteration ≈ 2 s):

- On a real 19-second recording: the best single preset scored 0.347 and the
  descent reached **0.673** in 273 iterations (12 min, CPU), still rising when the
  budget ran out — and continuing it for 45 minutes more reached **0.886**, so
  "still rising" was worth taking literally. All ten presets were scored first and
  the five female ones came in at 0.135-0.220 against 0.272-0.347 for the male
  ones, which is a useful sign the metric is not noise.
- Starting from the nearest preset, similarity climbed from **0.31 → 0.45**
  within eight iterations at `--lr 1e-3`.
- `--lr 0.02` **destroys** the voice within three steps: the style's own values
  average 0.02, so a step that size is a different voice, not a nudge. The
  default is 1e-3 for that reason.
- Numbers to read: ~0.3 is "a stranger of roughly the right kind", ~0.6 is
  recognisably related, ~0.87 is as close as the metric can see (the same style
  spoken twice scores 0.92). A single line wobbles by ±0.03 because every pass
  draws fresh flow noise — the smoothed column is the one that matters, and it is
  what picks the winner.
- 20 minutes ≈ 500 iterations, and 60 is better. There is no harm in
  `--minutes 120`; the best style so far is kept, so stopping early with Ctrl-C
  only costs the last few. Keep `--anchor` at its default on long runs — a run at
  0 came apart after ~700 iterations and only the kept best state survived.
- `--init-json` continues from a style file, which is how 0.673 became 0.886.

It is a likeness, not a forgery. The model was never trained to reproduce
arbitrary speakers.

## What is not optimised

`style_dp` — the rhythm tensor. It reaches only the duration predictor, whose
answer becomes an integer number of samples: a shape, not a differentiable
quantity, so no gradient can come back through it. An earlier version handed it
to the optimiser anyway and the only gradient it ever got came from the anchor
term pulling it back where it started. The rhythm you get is the nearest
preset's; only the timbre is fitted.

## Recording

20–40 seconds, one speaker, no music, no other voices, ordinary speaking voice.
Any language — the speaker model does not care what you say. More audio does not
help; clean audio does.

## Flags

| Flag | Default | Why you would change it |
| --- | --- | --- |
| `--minutes` | 20 | Longer runs get closer. |
| `--lr` | 1e-3 | Lower if the similarity jumps around; higher rarely helps. |
| `--anchor` | 0.02 | Pull towards the starting preset. Raise it if the voice starts sounding broken rather than different. |
| `--draws` | 4 | Renderings averaged per step. 1 is four times faster per step and wanders once it nears its plateau; see the two curves above. |
| `--steps` | 4 | Flow steps per pass. **Leave it.** A style fitted at 4 steps and rendered at 8 scores *lower* — +0.812 against +0.836, measured — because the step count is part of what it was fitted to. 2 steps is a different speaker outright (cos 0.47 to the same style at 4). |
| `--init` | auto | Force a starting preset (`F1`…`M5`) instead of scoring all ten. |
| `--device` | auto | `cuda`, `xpu`, or `cpu`. |
| `--models` | the app's | Path to `tts-models/supertonic-3` if this folder is not inside the data dir. |

## Requirements

PyTorch (~2 GB), torchaudio, onnx, onnx2torch, onnxruntime, soundfile, numpy.
No transformers: the WavLM route is gone.
A GPU is optional. The 29 MB speaker model downloads on the first run.

Nothing here talks to a server: the recording, the model and the optimisation
all stay on your machine.
