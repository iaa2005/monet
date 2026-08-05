---
title: Voice mode
description: When she does not hear you, will not shut up, or reads her stage directions aloud.
order: 2
---

Voice mode's algorithms are described in *Features → Voice mode, under the
hood*. This page is the symptom table.

## She cannot be interrupted

Interrupting rides on an adaptive loudness gate: speak **over** her at a
normal-to-loud voice for about a third of a second. If that genuinely does
nothing:

- Check the input device: the gate reads the same microphone as recognition.
  A headset that Windows switched away from hears nothing.
- Speakers very loud + mic very close = the echo estimate is high, and the
  bar (2× echo) may sit above your voice. Lower the speaker volume or use
  headphones — with headphones the echo estimate falls to near zero and a
  whisper interrupts.
- The Square button on the pill always works and also mutes the mic for the
  moment of stopping.

## She heard herself / my message contains her words

Echo leaking into recognition. The recorder restarts on short windows while
she speaks precisely to prevent accumulation; if you still see her phrases
in your bubbles, you are on speakers at high volume — the audio is louder
than the gate's ceiling. Headphones end this class of problem completely.

## Everything I said during her reply arrived as one giant message (historic)

Fixed: the recorder now discards echo windows instead of accumulating them.
If it reproduces, report it with the timeline visible in the chat.

## She said "breath breath" / I can see `<laugh>` in text

Expression tags leaking. The pipeline strips all known tags from the
transcript and the caption, doubles the working ones for the synthesiser
and drops the ones the voice cannot perform. Seeing a tag **as text** in a
bubble, or hearing one pronounced, means a tag escaped the net — note the
exact wording and position (start of paragraph? other language?) and
report; the rules are per-position and per-language and were built from
exactly such reports.

## She ignores me in another language

Recognition is GigaAM — a **Russian** model. English terms inside Russian
speech survive; whole sentences in French or German transliterate into
Cyrillic noise. She can *speak* other languages fine (typed input works),
she just cannot *hear* them.

## Short answers get lost

Utterances under ~2 KB of audio are discarded as noise. A lone «да» can
fall under the bar — use a phrase.

## No voice at all

- **Settings → Voice**: the speech model (~400 MB) must be downloaded and a
  voice picked. The mic button stays grey until recognition's model is in
  place too.
- The synthesiser runs in a child process; if it crashed you will see
  replies as text with no audio. Reopen voice mode (the child restarts with
  it) or restart the app.
- First synthesis after launch is slower (model load) — a second of delay
  on the first sentence is normal.

## Typed messages in a voice chat answer with the wrong voice/gender (historic)

The voice directive (including grammatical gender for Russian verbs) now
rides on every send bound to the voice chat, typed or spoken. If a typed
message ever comes back unspoken or in masculine forms from a female voice,
that is a regression — report it.
