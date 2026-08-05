---
title: Models and providers
description: Truncated replies, silent stops, invisible images, and runs that spin or stall.
order: 3
---

## The reply ends mid-sentence with a truncation warning

The provider cut the reply at its output limit (`max_tokens`). The app
flags it instead of pretending the thought ended there. Raise the model's
max output tokens in **Settings → Providers → model**, or ask the model to
continue — the context still holds everything.

## The run just… stopped, with nothing said

An empty reply (no text, no tool calls) reads as "done" to any agent loop.
The harness answers it the way you would — a bare "." — up to twice per
run, and each nudge is visible as a slim grey line. Two empties in a row
end the run for real; the stop reason then says the model gave up rather
than finished, which is the fact a post-mortem needs.

## "Going in circles — X ran N× with identical input"

Not an error: the harness caught the model re-issuing one identical call
and told it to change approach. If the run still cannot converge, its step
budget will land the plane with a hand-off summary. If you know what it
should do instead, say so — **Ctrl+S** injects your correction into the
running turn immediately.

## The model answered about an image it was never shown

A model whose declared modalities do not include images cannot see an
attached screenshot — the app saves the file into the chat's workspace and
tells the model the path instead, and says so under the composer at send
time. If you believe the model *can* see images, fix its modalities in
**Settings → Providers** (models added by hand default to what their id
implies; an explicit list always wins).

## Errors about thinking / reasoning parameters

Some models reject a requested reasoning effort outright (an API 400 with
wording like *does not support thinking*). Lower or clear the effort
selector in the composer for that model — retrying the same request cannot
succeed.

## A long chat got slower, then a "context" line appeared

Working as intended: tool outputs of replayable tools are cleared first
(the model can re-run them), and only then is older conversation summarised
by the model itself. The context-break line shows where the model's memory
now starts; everything above it is still on your screen and on disk, just
not in the prompt. Starting a fresh chat for a fresh task is still the
cheapest option.

## Local endpoints (Ollama, LM Studio, llama.cpp)

All three speak the OpenAI-compatible protocol and work as providers — no
API key needed for a localhost endpoint. Set the model's context window
honestly: the app budgets compaction from it, and an over-claimed window
means overflow errors arrive from the server instead of being prevented.

## Where to see why a turn ended

Every stop is labelled: finished, gave up (empty), hit its step budget,
truncated at max tokens, or aborted. The label lives on the turn's end in
the transcript; a run that ended for a budget reason also carries the
hand-off summary asking the model to state what is done and what remains.
