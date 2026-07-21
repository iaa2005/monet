---
title: Connectors
description: Giving the agent access to your mail, files, calendar and messaging — one permission at a time.
order: 6
---

A connector links a service you already use to the agent. Once an account is
connected, the agent gets tools for it: reading mail, listing files, checking
your calendar, sending a message.

## Accounts

Connect an account in **Settings → Connectors**. Several accounts of the same
service can coexist — two mailboxes, two drives — and each is independent.

Credentials go through the operating system's keystore, the same as provider API
keys. They are never written to a plain file.

## Permissions are per action, not per service

Connecting an account does not hand over the whole service. Every action a
connector offers carries an access level:

| Level | Default | Meaning |
| --- | --- | --- |
| `read` | allowed | Look at something: list mail, read an event |
| `write` | asks | Change something: send a message, create a file |
| `destructive` | asks | Remove something, irreversibly |

You can override the default per action, per account, so a mailbox can be
read-only while another may send.

## How the level meets the mode

The level is only half the decision; the other half is the run context.

- **Ask mode** — write and destructive both ask.
- **Auto mode** — read and write proceed; destructive still asks.
- **A routine, running unattended** — read proceeds; write requires a grant you
  gave when creating the routine.

> [!IMPORTANT]
> Destructive actions can never be granted for unattended use. A routine cannot
> delete your mail at 3am no matter how it is configured — the engine refuses,
> not the prompt.

## Connectors in Home

Home has no filesystem access, but it may use connectors, because a connector
talks to exactly one signed-in service rather than to your machine.
