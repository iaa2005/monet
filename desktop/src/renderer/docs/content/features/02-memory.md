---
title: Memory
description: How the agent accumulates durable knowledge about you, and how to control it.
order: 2
---

Memory is what makes the agent better in the tenth conversation than in the
first. It works in two tiers, and the split matters.

## During the day: notes

After a turn, a small pass writes what looked durable into a **daily log** — an
append-only file of timestamped bullets. Corrections you made, preferences you
stated, project context that is not visible in the code.

Nothing rewrites a memory file at this stage. That is the point: a cheap model
looking at a fragment of one conversation should never be able to delete facts
it cannot see.

## Overnight: consolidation

Once a day, in the small hours, a single pass reads the whole picture — every
memory file, the day's notes, what you have been working on — and reorganises
it: merging new facts in, dropping what has been contradicted, and rewriting the
index. If the computer is off at that hour, it catches up later.

## What you can control

In **Settings → Memory**:

- **Search and reference chats** — lets the agent look through past
  conversations.
- **Generate memory from chats** — the whole mechanism on or off.
- **Run extraction at most once per…** — how often the per-turn pass may run.
  Set it to **Never** to stop spending a request after every turn while keeping
  explicit memories and nightly consolidation working.
- **Consolidate now** — run the nightly pass immediately.

Every memory is a file you can read, edit or delete in that same panel.

> [!NOTE]
> Asking the agent directly — "remember that I deploy on Fridays" — saves it
> immediately, without waiting for the nightly pass.
