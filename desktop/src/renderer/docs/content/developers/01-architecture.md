---
title: Architecture
description: How the pieces fit — main process, renderer, and the vendored agent toolset.
order: 1
---

Code Monet is an Electron application with the usual three-part split, plus a
vendored copy of a professional coding agent's toolset.

## Main process

Owns everything with side effects: the agent loop, tool execution, the
permission gate, providers and their encrypted keys, the session database,
routines, connectors, sandboxes, and memory.

## Renderer

The UI. It holds no secrets and performs no side effects of its own — every
privileged action goes through IPC to the main process, which is what makes the
permission model meaningful.

## The vendored toolset

`src/vendor/leaked` is a third-party agent implementation. The app drives its
tools — their schemas, prompts, validation and permission checks — rather than
reimplementing them, which is why shell safety and file-edit discipline behave
like the real thing.

It is treated as read-only. App behaviour is built *around* it, never by editing
it, so it can be replaced wholesale.

## The agent loop

1. Build the system prompt (vendor sections + this app's additions + your memory).
2. Send the conversation and the tool schemas to the model.
3. For each tool call: validate input → PreToolUse hooks → permission gate →
   execute → PostToolUse hooks.
4. Feed results back; repeat until the model stops or the turn limit is reached.
5. Compact if the context is filling up.
