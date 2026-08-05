---
title: The app itself
description: Where your data lives, what a restart fixes, antivirus friction, and the big red levers.
order: 5
---

## What a restart actually fixes

The app is two programs: the window (UI) and a background process that runs
the agent, the tools and the voice synthesiser. UI changes arrive with a
simple reload; changes to the background half only take effect after a full
app restart. Rule of thumb after an update: **restart the app once** and
both halves are current.

## Where everything lives

Settings → General shows the data directory. Inside it: chat history and
transcripts, encrypted provider keys and connector tokens, memory, skills,
downloaded voice/recognition models, per-chat sandboxes and artifacts. Two
consequences:

- Back up that one folder and you have backed up the app.
- The folder can be moved from Settings; the app relinks itself.

Incognito chats are the exception: they live in memory only and leave
nothing in the folder.

## Antivirus / Windows Defender

Real-time protection occasionally flags freshly built temp files of
developer tooling (esbuild, bundlers) as "potentially unwanted" — the
symptom is a build or smoke test failing with *"file contains a virus"* on
a path under `%TEMP%`. That is a false positive on a file the toolchain
just wrote. Add the project folder to Defender's exclusions rather than
turning protection off — and if you do toggle it off to test, turn it back
on.

## Chats survive reloads mid-answer

The agent runs in the background process, so a window reload (or crash)
does not stop a running turn — events keep flowing and the transcript
catches up. History merging is id-based; a reload cannot eat the first half
of a chat.

## Rewind, branch, reset

- **Rewind** (under a user message, Code space): restores the workspace to
  the snapshot taken before that turn and drops the prompt back into the
  composer. Snapshots are taken after each completed turn.
- **Branch**: same cut point, but as a *new* chat; the original keeps
  everything.
- **Reset chat**: clears the model's context for this chat (the transcript
  stays). Session "allow always" grants die with it — by design.
- **Undo prompts**: drops the last N turns from the model's context without
  touching files.

## When something is truly wedged

1. Restart the app (fixes anything cached in the background process).
2. Check the data directory has free disk — transcripts, models and
   sandboxes all write there.
3. Voice models and the container image can be re-downloaded/rebuilt safely
   — deleting `tts-models/` or the Podman machine only costs a re-download.
4. The nuclear option is a new data directory (Settings → General): the app
   starts clean, and you can copy pieces back from the old folder later.
