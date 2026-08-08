---
title: Voice mode, under the hood
description: The full pipeline — on-device recognition, on-device speech, expression tags, and how interrupting actually works.
order: 12
---

Voice mode is fully on-device: nothing you say and nothing the app says back
ever leaves your machine. That choice dictates everything below.

## The pipeline

```
your voice → mic → VAD + adaptive gate → GigaAM (STT) → chat turn
                                                          ↓
     speakers ← PCM join ← Supertonic-3 (TTS) ← text chunks ← reply stream
```

- **Recognition** — Sber's **GigaAM**, running locally via sherpa-onnx.
  It is a Russian model: English words in a Russian sentence survive, but
  speaking a whole other language transliterates into nonsense («тюпарле
  франсе»). This is a model property, not a bug.
- **Speech** — **Supertonic-3**, ~400 MB of ONNX running in a forked child
  process so a slow synthesis can never freeze the app. Ten voices, each a
  separate 0.3 MB style file (table below). The letter in the id is
  load-bearing: a spoken Russian reply agrees with the voice's gender, so a
  male voice never says «я закончила».

## The ten voices

Supertone's own names and characters ([their docs][voices]); the use case is
theirs too, and it is a better description of a voice than any adjective.

| Id | Name | Sounds like | Made for |
| --- | --- | --- | --- |
| F1 | Sarah | Calm, slightly low; steady and composed | Customer service, guided instructions |
| F2 | Lily | Bright, cheerful, playful, youthful | Youth content, social video |
| F3 | Jessica | Clear announcer style; broadcast-ready | Commercials, formal presentations |
| F4 | Olivia | Crisp and confident; strong delivery | Business explainers, training |
| F5 | Emily | Kind and gentle; soft-spoken, soothing | Audiobooks, wellness |
| M1 | Alex | Lively and upbeat; clear standard tone | Promos, general narration |
| M2 | James | Deep and robust; calm, serious, grounded | Corporate, documentary |
| M3 | Robert | Polished and authoritative; trustworthy | Business presentations |
| M4 | Sam | Soft, neutral, youthful, approachable | Educational content, onboarding |
| M5 | Daniel | Warm and soft-spoken; storytelling | Audiobooks, relaxation |

[voices]: https://supertone-inc.github.io/supertonic-py/voices/

Each card carries a **voice map**: a 12×12 picture of the voice's own style
tensor — how it differs from the average of the ten. It is computed, not
shipped, so an imported or blended voice has one too, and a blend visibly sits
between its parents. (Supertone's cards do the same thing; their mixer draws
the tensor as a heatmap.)

## The language it reads with

Supertonic does not detect language — the text is handed to it wrapped in
`<lang>…</lang>`, and that tag decides the mouth. **Settings → Voice → Speech
language** is that tag: 31 languages, or *Auto*, which picks per sentence by
dominant script (so «Проверь этот PR» stays Russian, and Ukrainian is told
apart from Russian by the four letters only it has). The same list serves
dictation when the Whisper engine is selected.

Until this setting existed the app always sent `na` — language-agnostic —
which reads Russian with a foreign accent. If a voice ever sounded slightly
off, that was why.

## A voice of your own

A voice here is not a model — it is two style tensors in a JSON file, and the
398 MB model speaks with whichever pair it is handed. There are four ways to
get a new pair, and the paid one is the one that no longer works.

### From your own recording (free, offline, in the app)

**Settings → Voice → Build a voice from your recording.** Say anything for a
few seconds (or drop in an audio file). One extra 29 MB model — a CAM++
speaker embedder, run through the sherpa-onnx that already ships for GigaAM —
turns a clip into a vector describing *who* is speaking. Then the app searches:

```
speak a candidate → embed it → cosine against your recording → keep the best
```

The candidates are blends of the ten presets, so there are ten numbers to fit
rather than 12 928, and the loop is a (1+λ) evolution strategy: score all ten,
then perturb the weights, keep improvements, shrink the step when a round
brings none. About sixty real syntheses, two minutes, cancellable, and the
match score is shown because it is the honest number in the feature.

What you get is **the closest voice the model can build out of what it has** —
a family resemblance, not a clone. There is no style encoder in the released
model, so nothing on this machine can do better; the ceiling is the ten
presets and the space between them.

Verified rather than hoped: given Daniel's own synthesised speech as the
"recording", the search comes back with Daniel at 98% (`npm run
smoke:voicefit`).

### Blend two voices (free, offline, in the app)

**Settings → Voice → Blend a new voice.** A style is a point in a latent space,
so a convex combination of two points is a third voice. Pick two, drag the
slider, press *Listen*, name it, save. Both tensors are blended — the timbre
(`style_ttl`) and the rhythm (`style_dp`), because one parent's timing on the
other's voice sounds like the wrong person's pacing — and the weights are
normalised, so 2:2 is the same voice as 1:1 rather than one twice as loud.

*Listen* writes the blend under a fixed unregistered id, so it can be heard
without becoming a voice in the list. This is the same idea as
[Topping1's Supertonic-Voice-Mixer][mixer] (from [issue #44][issue], where
Supertone also confirmed there is no voice cloning in the released model),
minus the Python GUI.

[mixer]: https://github.com/Topping1/Supertonic-Voice-Mixer
[issue]: https://github.com/supertone-inc/supertonic/issues/44

### Import a style file

**Settings → Voice → Import a voice file** takes any Supertonic 3 style JSON.
It is validated on the way in: a Supertonic **2** embedding has different
dimensions and is refused by name, rather than failing later inside
onnxruntime with a shape error.

Where such a file comes from is the awkward part. Supertone's own
[voice builder](https://supertonic.supertone.ai/voice-builder) turns a minute
of your audio into one — for **$49 per voice**, and as of August 2026 it sells
none at all ("Purchases Unavailable"); the service closes **31 August 2026**.
You can listen there and not download.

### Clone properly (third-party, heavy)

The app's search is bounded by the ten presets. To go past them the tensor
itself has to be optimised, which needs gradients and a speaker-identity model:
[voice-builder-for-supertonic-3][clone] does exactly that (SpeechBrain's
ECAPA-TDNN). It is a notebook with PyTorch, it takes real time, and its own
README promises "a close, recognizable likeness rather than a studio-perfect
indistinguishable clone". Its output is a style JSON, so it imports here like
any other.

A different angle, if you want your own voice on a whole audiobook rather than
in the app: synthesise with a preset and convert the audio afterwards with RVC.
That is a GPU pipeline outside this app, not a style file.

[clone]: https://github.com/Fawzan09/voice-builder-for-supertonic-3

Whatever the source: removing the 398 MB model (the *Remove* button)
deliberately leaves `tts-models/custom` alone. A preset can be downloaded
again; your own voice may not be.

## How the reply becomes speech

The model streams text; the voice cannot wait for the whole reply, and the
synthesiser cannot take unlimited input. Three layers of chunking:

1. **Paragraphs first.** The stream is split on blank lines; numbered lists
   and paragraphs are natural pause points, so pauses land where a person
   would breathe — not after every sentence.
2. **Sentence groups.** Inside a paragraph, sentences accumulate until the
   group passes ~200 characters, then it is sealed and sent to the
   synthesiser. A trailing scrap under 20 characters is merged into its
   neighbour instead of becoming a comically short utterance.
3. **The model's own budget.** Past ~300 characters Supertonic starts
   racing — more text, barely more audio. So the child splits anything
   longer at sentence ends (falling back to clause commas, then spaces),
   synthesises the pieces separately and joins them with 120 ms of silence.
   You hear one continuous phrase; the model never sees an input it
   mishandles.

Markdown is flattened before any of this: bold markers, list bullets, links,
code fences and horizontal rules never reach the mouth (or the caption pill).

## Expression tags

Supertonic understands inline tags like `<laugh>`. The published list has
ten; **live testing found only six that actually perform**, and only under
specific conditions — the app enforces all of them automatically:

| Tag | Works | Rules |
| --- | --- | --- |
| `<laugh>` | yes | doubled, sentence boundary; may open a paragraph |
| `<breath>`, `<sigh>` | yes | doubled, sentence boundary; **not** paragraph-initial (would be read aloud — the app silently moves a leading one past the first sentence) |
| `<cough>`, `<sad>` | yes | doubled, sentence boundary; `<sad>` is Russian-only |
| `<scream>` | partly | only hugging a short interjection: `<scream> Ааа <scream>`; Russian-only |
| `<surprise>`, `<angry>`, `<yawn>`, `<throatclear>` | **no** | pronounced as English words — stripped before synthesis, and the model is told not to use them |

Single tags are a coin flip and mid-sentence tags are a dead zone, so runs
are collapsed to exactly two. In languages other than Russian only laugh,
breath and cough survive (field-tested in French). You never see any of
this: the transcript and the caption strip every tag.

## Interrupting (barge-in)

The hard problem: while the app speaks, the microphone hears the speakers.
Chromium's echo cancellation only removes WebRTC audio — the app's own voice
comes back as ordinary sound. The detector:

1. While audio plays, the mic level feeds an **adaptive echo estimate**
   (exponential moving average). The interrupt threshold is `2×` that
   estimate, clamped to a floor and ceiling.
2. The estimate **freezes the moment the level crosses the threshold**
   (after a 500 ms warm-up). Without this, your own shout teaches the
   detector that shouting is normal — the original bug.
3. Crossings fill a **leaky bucket**: five net ticks trigger the interrupt.
   A hard counter would reset on every consonant gap and never fire; the
   bucket leaks one per quiet tick instead.
4. On trigger: playback stops, everything queued is cleared, and every
   in-flight synthesis is **generation-stamped** — a chunk that comes back
   after the interruption is recognised as stale and dropped, so the voice
   cannot "finish its sentence" from beyond the grave.

While nothing has been heard yet, the recorder restarts on a short window
(2 s while the app is speaking, 5 s when idle) so echo never accumulates
into your next message.

## Dictation is pseudo-streaming

The composer's mic works the same way in miniature: the models are batch
models (no partial hypotheses), so instead a small voice-activity detector
cuts the recording at every ~0.7 s pause, sends the finished fragment to
recognition, and appends the text to the input while you keep talking. The
fragments land in spoken order (a sequential queue guarantees it), and the
input stays fully typeable throughout — dictate a phrase, type a
correction, keep dictating.

## Where the voices and the ears come from

Every model this app installs — speech recognition, speech synthesis, page
reading, all of it — is downloaded from **one account**,
[huggingface.co/iaa2005](https://huggingface.co/iaa2005). They are mirrors,
and each one credits its original: GigaAM is Sber's, Whisper is OpenAI's
through Xenova's ONNX conversions, the voice is Supertone's.

The reason is dull and worth stating. Before, the models came from six
different accounts, and any of those can rename a repository, put it
behind a licence click, or delete it — at which point installing a voice
fails with a 404 for somebody who did nothing wrong. Mirroring means the
app depends on one place instead of six.

Only models whose licence permits redistribution were copied, the licence
files travel with them, and the copies are byte-for-byte identical to the
originals — the downloader checks a sha256 for every file and would refuse
them otherwise.

## Small print

- Very short utterances (under ~2 KB of audio) are discarded as noise —
  a lone «да» may be dropped; say a full phrase.
- A message **typed** into the voice chat gets a spoken reply too, in the
  same voice, with the same tag rules — the voice directive rides on every
  send bound to that chat, not only on spoken ones.
- Asking her to repeat something verbatim works indefinitely: chunk dedupe
  is scoped to a single reply, not to the whole session.
- Text you speak or type mid-reply is **injected** into the running turn
  (see *Steering a run mid-flight*), so "стоп, не так" acts before the next
  step rather than after the whole answer.
