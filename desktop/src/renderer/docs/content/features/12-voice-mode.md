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
  process so a slow synthesis can never freeze the app. Ten voices (F1–F5,
  M1–M5), each a separate small style file.

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
