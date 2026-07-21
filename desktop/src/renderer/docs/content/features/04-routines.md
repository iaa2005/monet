---
title: Routines
description: Tasks that run on a schedule, on a webhook, or on demand — with nobody watching.
order: 4
---

A routine is an instruction the agent carries out automatically. A morning
briefing, a nightly dependency scan, a triage pass over new issues.

## Creating one

Describe what you want in plain language and press **Draft routine** — the
schedule, connectors and output are filled in for you, and you can correct
anything before saving. Or start from a template, or write it by hand.

## Triggers

- **Schedule** — a cron expression in your local time.
- **Webhook** — an inbound URL fires it.
- **Event** — a connector is polled and the routine runs on a match.
- **Manual** — only when you press Run.

## Output

A routine can open a chat with its result, send a notification, or deliver
through a connector.

## Permissions when nobody is watching

A routine runs unattended, and that changes what is allowed. Actions that would
normally ask a human are refused unless you granted them at creation time.
Destructive actions cannot be granted at all.

> [!IMPORTANT]
> Grants are per action and chosen when you create the routine. If a routine
> needs to send mail on your behalf, you must say so explicitly — it cannot
> decide that for itself at 3am.

## Choosing a model

A routine can pin its own provider and model. A nightly digest has no reason to
run on the expensive model you chat with.
