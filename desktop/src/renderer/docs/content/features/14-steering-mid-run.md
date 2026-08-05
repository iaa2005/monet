---
title: Steering a run mid-flight
description: Inject, queue, or stop — and how files travel into a turn that is already working.
order: 14
---

While the agent works, the send button becomes three: **inject**, **queue**,
**stop**. They answer different questions.

## Inject (Ctrl+S) — "hear this NOW"

The point of typing mid-run is usually *"stop, not like that"* — a
correction that must land before the next step, not after the whole reply.
Injection hands your text to the **running** turn: it is delivered at the
next step boundary, wrapped in framing that tells the model this is the
user steering, not tool output, and that it should fold the correction in
without restarting work that is already done.

What you see: the message appears immediately as a dashed **"Joining the
run…"** chip, and turns into a regular bubble the moment it is delivered.
If the run ends or is stopped before delivery, the chip disappears — an
undelivered correction against work that already changed would only mislead
the next turn, so it dies with the run (this matches what actually happens
under the hood).

Why "next step boundary" and not instantly: a conversation with tool calls
has a rigid shape — an assistant message carrying tool calls **must** be
followed by the message carrying their results. The only legal place for
your words inside a running turn is beside those results, so that is where
they ride.

## Files mid-run

Attachments work in both mid-run paths:

- **Injected** files go through the same pipeline as a normal send: images
  the current model can see travel as real image blocks right beside your
  note; anything the model cannot consume inline (or any non-image) is
  saved into the chat's sandbox / workspace and the model gets the path
  and a note telling it how to use the file.
- **Queued** files simply ride with the queued message and are sent with it
  when the run finishes.

Pasting works everywhere: **Ctrl+V** with an image or video in the clipboard
stages it in the composer, mid-run or not.

## Queue (Ctrl+Enter) — "after this one"

A queued message waits, visibly, under the transcript with a ⏱ label and a
remove button, and is sent automatically as a fresh turn the moment the
current run ends. Use it for the *next* task; use inject for corrections to
the *current* one.

## Stop

Stops the current chat's run only — other chats keep working in the
background. In voice mode the same interrupt fires when you simply start
talking over her (see *Voice mode*).
