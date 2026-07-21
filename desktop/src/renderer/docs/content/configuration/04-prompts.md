---
title: Editing the prompts
description: Which file controls what, how to change it safely, and how to undo.
order: 4
---

Every instruction the agent receives is a Markdown file you can edit. This is
the deepest customisation the app offers.

## Where

`prompts/` in the data directory (**Settings → Advanced → open the folder**).
Files appear there the first time the app needs them, so a fresh install may
show only a few until you have used more features.

## What the files are

| File | Controls |
| --- | --- |
| `system-*.md` | The core system prompt sections |
| `method.md` | How the agent approaches a task |
| `discipline.md` | The edit / verify / git rules it always follows |
| `tool-<name>.md` | What the model is told about one tool |
| `memory-*.md` | The memory instructions |
| `home-directive.md` | The extra rules for the isolated space |

A tool description like `tool-bash.md` is what the model reads to decide when and
how to use that tool — small wording changes there have large effects on
behaviour.

## Editing safely

1. Open the file, change it, save.
2. **Reload** in Settings, or restart, to apply.
3. To undo, **delete the file** — the built-in default returns on the next
   reload. This is the reliable way back, better than trying to reconstruct the
   original by hand.

> [!WARNING]
> Tool descriptions are load-bearing. Weakening one can make the agent stop
> using a tool, or use it wrongly. Change one thing, test it, and keep the
> original text somewhere until you are sure.

> [!NOTE]
> Deleting a file always restores its default. Nothing you can do here is
> permanent, which makes this a safe place to experiment.
