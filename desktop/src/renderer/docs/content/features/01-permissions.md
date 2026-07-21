---
title: Permission modes
description: Who decides whether a tool may run — and what each mode actually changes.
order: 1
---

Every tool call passes through a permission check before it runs. The mode you
pick decides what happens when that check is uncertain.

## The modes

**Ask** (default) — anything that changes something asks first.

**Accept edits** — file edits inside your workspace run without asking; shell
commands and anything outside the workspace still ask.

**Auto** — read-only tools and workspace-scoped edits run silently; risky
actions still ask.

**Plan** — nothing that changes anything may run. The agent researches, then
hands you a plan to approve.

**Skip all approvals** — nothing asks. Use it only when you are watching.

## What "risky" means

It is not a list of tool names. Shell commands are parsed and judged by the same
rules a professional coding agent uses: the command's syntax tree, the paths it
touches, whether it pipes a download into a shell. `echo hi` and `git status`
are recognised as harmless and run without interrupting you. `rm -rf …` and
`curl … | sh` are escalated to you no matter which mode you are in short of
skipping approvals entirely.

> [!WARNING]
> In **Auto**, file edits are allowed only INSIDE your workspace. A write aimed
> anywhere else on disk still asks. This is deliberate: a mode meant to reduce
> friction should not quietly widen what the agent can reach.

## Allow always

When you approve an action you can allow it for the rest of the session. That
grant is per chat and per tool, and it is cleared when the chat is reset.
