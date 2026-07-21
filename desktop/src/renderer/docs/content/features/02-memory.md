---
title: Memory
description: How memory works in two tiers, every setting, the files on disk, and how to fix a wrong memory.
order: 2
---

Memory is what makes the agent better in your tenth conversation than your
first. It works in two tiers, and the split is deliberate.

## During the day: the log

After a turn, a small background pass writes what looked durable into a
**daily log** — an append-only file of timestamped bullets. Corrections you
made, preferences you stated, project facts not visible in the code.

Nothing rewrites a memory file at this stage. That is the safeguard: a cheap
model looking at a fragment of one conversation must never be able to delete
facts it cannot see. The worst a bad note does is get ignored that night.

## Overnight: consolidation

Once a day, between about 03:00 and 05:00 local, a single pass reads the whole
picture — every memory file, the day's log, what you have been working on — and
reorganises it: merging new facts in, dropping contradicted ones, converting
"yesterday" to a real date, and rewriting the index. If the computer is off at
that hour, it catches up the next time it is on and enough time has passed.

Your `profile` memory is never deleted by this pass.

## The settings

**Settings → Memory**:

| Setting | Effect |
| --- | --- |
| **Search and reference chats** | Adds the tool that lets the agent look through past conversations |
| **Generate memory from chats** | The whole mechanism, on or off |
| **Run extraction at most once per…** | How often the per-turn pass may run: 1–60 minutes, or **Never** |
| **Consolidate now** | Run the nightly pass immediately |

**Never** is not the same as switching memory off. It stops the per-turn note —
so no request is spent after each turn — while explicit "remember this" and the
nightly consolidation keep working. Choose it if you want memory but not a
background call on every turn.

The status line under the button shows when consolidation last ran, what it did,
and how many notes are waiting.

## The files

Everything is plain Markdown under `claude/memory/` in the data directory:

- `profile.md` — who you are.
- `topics/<name>.md` — a sustained interest or way of working.
- `areas/<name>.md` — a long-running project.
- `MEMORY.md` — the index, always loaded into context.
- `logs/YYYY/MM/YYYY-MM-DD.md` — the raw daily notes.

Each file has a title and summary, then the facts. You can open, edit, or delete
any of them in **Settings → Memory** — or in the folder directly.

## Using the background model

The per-turn pass and the nightly consolidation are background work, so they run
on your background model if you set one (**Configuration → Model routing**). A
local model makes memory upkeep free.

> [!TIP]
> Telling the agent "remember that I deploy on Fridays" saves it at once, with
> the full context of why it matters — better than waiting for a pass to guess
> it from the transcript.

## Fixing a wrong memory

Three ways, in order of bluntness:

1. **Tell the agent** it is wrong — "forget that I use npm, it's bun now". It
   updates the file.
2. **Edit the file** in Settings → Memory.
3. **Delete it** if it is entirely wrong; the next consolidation will not bring
   it back unless the fact reappears in conversation.
