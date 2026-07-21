---
title: What Code Monet is
description: An agent that does real work on your machine, with the tools of a professional coding agent.
order: 1
---

Code Monet is a desktop application that runs an AI agent on your own computer.
The agent does not just answer questions: it reads and writes files, runs
commands, browses the web, calls your connected services, and remembers what it
learns about you between conversations.

## The two spaces

Every chat happens in one of two spaces, and the difference is a real boundary,
not a label.

**Code** works on your actual filesystem. The agent reads and edits real files,
runs real commands, and uses git. Use it for programming, for scripts, for
anything that must touch your project.

**Home** is isolated. The agent has no access to your filesystem or shell at
all — it gets a per-chat sandbox instead, where it can write files and run
Python. Use it for everyday tasks, analysis and drafting, where nothing should
be able to reach your machine by accident.

> [!NOTE]
> The boundary is enforced when a tool RUNS, not just when it is offered. An
> agent in Home that tries to call a filesystem tool it remembers from
> elsewhere is refused.

## Where the power comes from

The agent runs the same toolset as a professional coding agent — file editing
with read-before-write enforcement, shell commands checked against a real
permission engine, code search, language-server lookups — rather than a
simplified imitation. On top of that sit the things a desktop app can do that a
terminal cannot: a sandbox, a browser, connectors to your services, scheduled
routines, and long-term memory.

## What to read next

- **Your first conversation** — how a turn actually works.
- **Permission modes** — the single most important setting to understand.
- **Memory** — why the agent gets better at knowing you over time.
