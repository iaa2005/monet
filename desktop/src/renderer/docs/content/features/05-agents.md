---
title: Sub-agents and teams
description: Delegating work to agents that run in parallel — and steering them while they run.
order: 5
---

The agent can delegate to sub-agents: separate runs with their own context,
useful for open-ended searching and for work that would otherwise flood the main
conversation.

## Background agents

A sub-agent launched in the background returns immediately. It keeps working
while you and the main agent carry on, and its report is delivered into the
conversation when it finishes — including if you send another message in the
meantime.

## Addressing them

Background agents are named ("explore", then "explore-2"). The main agent can:

- **TeamList** — see who is running, for how long, and what is unread.
- **SendMessage** — send one of them a correction or a new constraint. It lands
  in that agent's inbox and is read at its next step, so it never interrupts a
  tool call mid-flight.
- Stop one by name when its work is no longer needed.

> [!TIP]
> Prefer messaging an agent over stopping it. Stopping discards the progress it
> has already made; a message redirects it while keeping that work.
