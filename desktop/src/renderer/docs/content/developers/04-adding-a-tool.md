---
title: Adding a tool
description: What a tool has to provide, and the decisions that matter.
order: 4
---

Tools are built with the vendored `buildTool` factory and registered in
`src/main/agent/vendor-tools.ts`.

A tool provides its name, a Zod input schema, a prompt (what the model is told
about it), `call()`, and a mapper turning its result into a tool-result block.

## The decisions that matter

**`isReadOnly`** — drives the permission gate. Claiming read-only for something
that writes bypasses the protection users rely on.

**`isConcurrencySafe`** — whether two calls may overlap.

**Space** — add the name to `HOME_TOOL_NAMES` only if it cannot reach the host
filesystem or shell. This is the isolation boundary, and it is enforced at
execution time.

**Prompt** — wrap it in `tunablePrompt(key, default)` so users can edit it, and
so it is materialised as a file in `prompts/`.

> [!NOTE]
> If a tool needs to ask the user something, do not invent a channel: pass a
> callback down through the tool-use context, as AskUserQuestion and
> ExitPlanMode do.
