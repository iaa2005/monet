# Clone your voice for Code Monet

This folder turns a recording of your voice into a **Supertonic 3 style file** —
the 0.3 MB JSON the app imports in *Settings → Voice → Import a voice file*.

```bash
pip install -r requirements.txt
python clone.py voice.wav --name Sasha --minutes 20
```

`voice.wav` is already here if the app recorded it for you. The result is
`Sasha.json` next to this README.

## What it actually does

Supertonic's voice is two tensors. Nothing published turns audio into them
directly — there is no style *encoder* — so this program treats them as the only
unknowns and optimises them:

```
style → text encoder → flow matching → vocoder → waveform
                                                    ↓
       loss = 1 − cosine( WavLM-L4 statistics of it, of your recording )
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

## What to expect

Measured on this pipeline (CPU, one core-heavy iteration ≈ 2 s):

- With the speaker loss on a real 19-second recording: the best single preset
  scored 0.347 and the descent reached **0.673** in 273 iterations (12 min, CPU),
  still rising when the budget ran out. All ten presets were scored first and the
  five female ones came in at 0.135-0.220 against 0.272-0.347 for the male ones,
  which is a useful sign the metric is not noise.
- Starting from the nearest preset, similarity climbed from **0.31 → 0.45**
  within eight iterations at `--lr 1e-3`.
- `--lr 0.02` **destroys** the voice within three steps: the style's own values
  average 0.02, so a step that size is a different voice, not a nudge. The
  default is 1e-3 for that reason.
- Numbers to read: ~0.3 is "a stranger of roughly the right kind", ~0.6 is
  recognisably related, past ~0.75 is a good likeness. A single line wobbles by
  ±0.03 because every pass draws fresh flow noise — the smoothed column is the
  one that matters, and it is what picks the winner.
- 20 minutes ≈ 500 iterations. There is no harm in `--minutes 120`; the best
  style so far is kept, so stopping early with Ctrl-C only costs the last few.

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
| `--steps` | 4 | Flow steps per pass. 8 is more faithful and twice as slow. |
| `--init` | auto | Force a starting preset (`F1`…`M5`) instead of scoring all ten. |
| `--device` | auto | `cuda`, `xpu`, or `cpu`. |
| `--models` | the app's | Path to `tts-models/supertonic-3` if this folder is not inside the data dir. |

## Requirements

PyTorch (~2 GB), torchaudio, onnx, onnx2torch, onnxruntime, soundfile, numpy.
No transformers: the WavLM route is gone.
A GPU is optional. The 29 MB speaker model downloads on the first run.

Nothing here talks to a server: the recording, the model and the optimisation
all stay on your machine.
