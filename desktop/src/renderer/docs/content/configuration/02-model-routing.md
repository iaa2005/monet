---
title: Model routing
description: Sending the background work to a cheaper or local model — what counts as background, and how to set it.
order: 2
---

Not everything the app does is the conversation. Several jobs call a model
quietly, and none of them needs your best one:

- writing a memory note after a turn,
- the nightly memory consolidation,
- the Reflect digest,
- drafting a routine from your description.

Left alone, these run on whatever you chat with — so a frontier model gets
billed to turn "prefers bun" into a bullet point.

## Setting the background model

**Settings → Advanced → Background model**:

1. Choose a provider, or leave it on **Same as the active provider**.
2. Choose one of that provider's models, or leave it on the provider's default.

That is all. The next background job uses it.

## Point it at a local model, and it is free

The strongest use of this is a local model. Background jobs are small and
tolerant — a 7–8B model handles them well — so a local server means memory
upkeep, digests and drafts cost nothing.

Set up a local provider once (see **Providers and models**), then select it
here.

## The fallback

If the provider you chose is later deleted, background work falls back to the
active provider rather than stopping. Work quietly degrading to a pricier model
is a minor annoyance; work silently not running is a bug you would not see — so
the app chooses the former.

## Per-routine models

A routine can pin its own provider and model, independent of both the chat model
and this background model — a nightly digest on a cheap model regardless of
anything else. See **Routines**.

> [!NOTE]
> These three levels are independent: the chat model in the composer, the
> background model here, and a routine's own pin. Nothing you set in one changes
> another.
