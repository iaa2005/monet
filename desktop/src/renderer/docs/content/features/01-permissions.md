---
title: Permission modes
description: What each mode allows, how "risky" is actually decided, and how to choose per task.
order: 1
---

Every tool call passes a permission check before it runs. The mode sets what
happens when that check is uncertain. Change it from the composer, per chat.

## The five modes

| Mode | Read tools | Edits in workspace | Edits outside | Shell | Risky shell |
| --- | --- | --- | --- | --- | --- |
| **Ask** | run | ask | ask | ask | ask |
| **Accept edits** | run | run | ask | ask | ask |
| **Auto** | run | run | ask | safe run | ask |
| **Plan** | run | blocked | blocked | blocked | blocked |
| **Skip approvals** | run | run | run | run | run |

## What "risky" actually means

It is not a list of tool names. A shell command is parsed — its syntax tree, the
paths it touches, whether it pipes a download into a shell — by the same engine a
professional coding agent uses. So the judgement is per command:

| Command | Verdict |
| --- | --- |
| `echo hi`, `git status`, `ls` | runs, even in Auto |
| `rm -rf build` | asks |
| `curl … ` piped into `sh` | asks |
| `npm install <pkg>` | asks |

This is why Auto is usable: the safe majority of shell work does not interrupt
you, and only the genuinely consequential commands do.

## The one subtlety worth knowing

In **Auto**, file edits run without asking **only inside your workspace**. The
same edit aimed anywhere else on disk still asks. A mode meant to cut friction
must not quietly widen what the agent can reach — so the boundary is the working
directory, enforced by the rules, not by a tool name.

## Allow always

When a prompt appears you can approve just this once, or for the rest of the
session. A session grant is per tool and per chat, and it is cleared when you
reset the chat.

## Which mode to use

- **Ask** — anything unfamiliar, or a repo that matters.
- **Accept edits** — a focused editing session where you trust the direction and
  do not want to confirm each save.
- **Auto** — routine work where you want shell commands judged on their merits.
- **Plan** — a large or risky change you want to see mapped before a line moves.
- **Skip approvals** — a throwaway sandbox, and only while you are watching.

> [!WARNING]
> **Skip approvals** turns off every prompt, including the ones in front of
> destructive commands. Use it deliberately and briefly, never as a default.

## Plan mode end to end

In Plan mode the agent may only read and research; nothing that changes anything
can run. When it is ready it hands you a plan and asks you to approve, approve
with auto-accepted edits, or keep planning with a note. Approving switches the
mode for the rest of that turn, so it starts work straight away rather than
hitting a wall on its next call.
