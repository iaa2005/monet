---
title: Routines
description: Step by step — creating a routine, cron syntax, grants for unattended runs, and why one might not fire.
order: 4
---

A routine is an instruction the agent carries out automatically: a morning
briefing, a nightly dependency scan, a triage pass over new issues.

## Creating one

**Settings → Routines**, then one of three ways in:

**Draft it.** Describe what you want — "summarize my open PRs every weekday
morning" — and press **Draft routine**. The name, instruction, schedule,
connectors and output are filled in; correct anything before saving.

**From a template.** Eight ready-made ones, each with a sensible schedule.

**By hand.** **New routine** and fill the form.

## The form, field by field

| Field | What it decides |
| --- | --- |
| **Name** | What you see in the list |
| **Instruction** | What the agent is told, every run. Write it self-contained — it has no memory of your chat |
| **Trigger** | Schedule, webhook, connector event, or manual only |
| **Model** | Pin a provider/model, or leave it on whatever is active |
| **Space** | Code (your files) or Home (isolated) |
| **Connectors** | Which services this routine may use |
| **Grants** | Which write actions may run with nobody watching |
| **Output** | Open a chat, send a notification, or deliver via a connector |
| **Condition** | An optional yes/no gate asked before the real work |

### Writing the instruction

The routine starts from nothing every time. "Do the usual check" means nothing
to it. Name the repository, the mailbox, the label, the threshold — everything
the task needs.

## Cron, in your local time

Five fields: minute, hour, day of month, month, day of week.

```
30 9 * * 1-5     09:30, Monday to Friday
0 */4 * * *      every four hours, on the hour
0 8 1 * *        08:00 on the 1st of each month
15 22 * * 0      22:15 on Sundays
```

Day of week is `0`–`6` with `0` = Sunday. The next run time is shown under the
field as you type — trust that over your reading of the expression.

> [!NOTE]
> Schedules follow your computer's local time, including daylight saving. A
> routine set for 09:30 stays at 09:30 after the clocks change.

## Conditions

A condition asks the model a yes/no question first and skips the run on "no" —
"are there any PRs opened since yesterday?". It costs one cheap call and can
save a pointless full run and a notification.

## Grants: permissions with nobody watching

A routine runs unattended, so anything that would normally ask a human is
refused by default. To let a routine send mail, you must grant that action when
you create it.

| Action level | Interactive | In a routine |
| --- | --- | --- |
| `read` | runs | runs |
| `write` | asks | only if granted |
| `destructive` | asks | **never**, not grantable |

> [!IMPORTANT]
> The refusal is enforced by the permission engine, not by instructions in the
> prompt. A routine that is told to delete something will be stopped even if the
> instruction is emphatic.

## Running and inspecting

**Run now** fires it immediately and opens the resulting chat — the way to test
one without waiting for its schedule. The list shows the last run, its status,
and a link to what it produced.

## Why a routine did not fire

- **The app was not running.** Schedules need the app open; a missed slot is not
  replayed.
- **It is disabled.** The switch on the row.
- **The condition returned "no."** The run is recorded as skipped, not failed.
- **A required action was not granted.** The run reports the refusal.
- **No provider is configured**, or the pinned model no longer exists.
