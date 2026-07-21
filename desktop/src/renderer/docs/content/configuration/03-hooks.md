---
title: Hooks
description: Running your own commands before and after the agent's tools.
order: 3
---

A hook is a command of yours that runs at a defined point in the agent's work.
Use them to enforce a rule, block something, or feed extra context in.

## Where they live

`hooks.json` in the application's data directory.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "my-audit-script.sh" }]
      }
    ]
  }
}
```

The tool call is passed to your command as JSON on stdin.

## What the exit code means

For **PreToolUse**:

- **0** — allow the call. Nothing is shown.
- **2** — BLOCK the call. Your stderr is given to the model as the reason.
- anything else — the call proceeds; stderr is shown to you only.

## Available events

`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and the session and
notification events.

> [!CAUTION]
> Hook commands run under bash on every platform, including Windows (Git Bash).
> A hook written in `cmd` syntax will appear to do nothing.

> [!IMPORTANT]
> Hooks are read ONLY from your data directory. A `.claude/settings.json`
> inside a project you open is deliberately ignored — otherwise cloning a
> repository would let it run commands on your machine before you saw anything.
