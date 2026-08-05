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

### How `src/main` is laid out

One folder per subject; the root holds only what everything else needs.

| Path | What lives there |
| --- | --- |
| `index.ts`, `data-dir.ts`, `net-fetch.ts` | the entry point, where user data lives, and how the app reaches the network — the three things nearly every module depends on |
| `agent/` | the run loop, tools, permissions, compaction, sub-agents |
| `ipc/` | one module per IPC surface; the only door the renderer has |
| `session/` | the session database, transcripts, purge, task log, per-chat desk state |
| `app/` | Electron shell concerns: tray, icon, power, beta gate, notifications, the dev API, the user profile |
| `skills/` | skills as an ecosystem: built-ins, sources, registry, marketplace, the security audit |
| `workspace/` | the user's project on disk: file search, change watching, CLAUDE.md |
| `directory/` | the community catalog repo — its config and the GitHub rate budget |
| `provider/`, `llm/` | which model is active, and how a request is spoken to it |
| `browser/`, `computer/`, `sandbox/` | the surfaces the agent acts on |
| `stt/`, `tts/` | on-device speech in and out |
| `memory/`, `verify/`, `plan/`, `routines/`, `connectors/`, `mcp/`, `acp/` | the named features, each self-contained |

The rule the layout follows: a file belongs to the subject it serves, not to
the layer it happens to sit in. Anything that would need a second folder to be
understood belongs in the same folder as what it serves.

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
