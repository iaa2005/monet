---
title: Skills
description: Reusable procedures the agent can pull in when a task calls for one.
order: 9
---

A skill is a packaged procedure — instructions, and optionally files — that the
agent loads when it is relevant. Where a prompt tells the agent how to behave
always, a skill tells it how to do one particular kind of job, and costs nothing
until used.

## Using them

The agent sees a catalogue of installed skills and invokes one by name when a
task matches. You can also ask for one directly.

## Managing them

**Settings → Skills** lists what is installed and lets you write, upload or
edit one. A skill is a folder with a `SKILL.md` describing what it is for and
what to do, so writing your own is a matter of writing that file.

Ready-made ones come from the **Directory**, which reads any GitHub repository
whose folders contain a `SKILL.md` — the default catalogue plus any repo you
add yourself.

## In Home

Skills work in Home too. A skill that ships files has them copied into the
chat's sandbox rather than onto your machine.
