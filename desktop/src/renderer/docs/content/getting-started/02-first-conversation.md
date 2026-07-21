---
title: Your first conversation
description: How a turn works, what the agent does between your messages, and how to steer it.
order: 2
---

You type a message; the agent works until it has an answer. Between those two
moments it may call tools many times — reading files, running a command,
searching the web — and you see each step as it happens.

## Choosing a space

Pick **Code** if the task involves your files or your project. Pick **Home** if
it does not. The space is per chat, so a conversation cannot drift from one to
the other halfway through.

## Choosing a model

The model picker in the composer switches between the models you configured.
Different models have different strengths and costs; a cheap model is fine for
routine work, and you can point background work at a different model entirely
(see **Model routing**).

## Interrupting

Stopping is always safe. The agent finishes the tool call in flight, then stops
cleanly — nothing is left half-applied that would not have been half-applied by
a crash.

## Attachments

Drop in an image, a PDF, a spreadsheet. If the active model cannot read that
kind of file, the file is still saved into the chat's workspace and the agent is
told where it is, so it can open it with its own tools instead of the attachment
being rejected.

> [!TIP]
> Long conversations are compacted automatically as they approach the model's
> context limit. Recent turns are kept word-for-word; see **Context and
> compaction** for what that means in practice.
