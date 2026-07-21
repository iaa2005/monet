---
title: Hooks
description: Full reference — file format, every event, exit codes, JSON in and out, and worked examples.
order: 3
---

A hook is your own command, run by the app at a defined point in the agent's
work. Hooks are how you enforce a rule the agent cannot talk its way out of:
they are code, not instructions.

## The file

`hooks.json`, in the application's data directory (**Settings → Advanced** shows
the path; the same folder holds `prompts/`).

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "audit.sh", "timeout": 10 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{ "type": "command", "command": "npx prettier --write $CLAUDE_FILE" }]
      }
    ]
  }
}
```

- **matcher** — which tool this applies to. A plain name, or a regular
  expression for several. Omit it to match every tool.
- **command** — run through bash. Relative paths resolve against your workspace.
- **timeout** — seconds; the hook is killed after that and treated as a failure.

Press **Reload hooks** after editing, or restart. Editing the file alone changes
nothing until the app re-reads it.

## Events

| Event | Fires | Can it block? |
| --- | --- | --- |
| `PreToolUse` | Before a tool runs, before the permission prompt | Yes |
| `PostToolUse` | After a tool returns successfully | No — but it can add context |
| `PostToolUseFailure` | After a tool errors | No |
| `SessionStart` | A conversation begins | No |
| `SessionEnd` | A conversation ends | No |
| `Notification` | The app raises a notification | No |

## What your command receives

The event is written to your command's **stdin** as one JSON object:

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf build", "description": "clean" },
  "tool_use_id": "toolu_01ABC",
  "session_id": "…",
  "transcript_path": "…"
}
```

`PostToolUse` additionally carries the tool's `response`.

## What your exit code means

For **PreToolUse**:

| Exit | Effect |
| --- | --- |
| `0` | Allow. Your stdout is not shown |
| `2` | **Block.** Your stderr is given to the model as the reason |
| other | Proceed anyway; stderr is shown to you only |

For **PostToolUse**, exit `2` does not undo anything — the tool already ran —
but your stderr is delivered to the model immediately.

## Worked examples

### Block commits that skip verification

```bash
#!/usr/bin/env bash
input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // ""')
if echo "$cmd" | grep -q -- "--no-verify"; then
  echo "Committing with --no-verify is not allowed here. Fix the hook failure." >&2
  exit 2
fi
exit 0
```

### Keep the agent out of a directory

```bash
#!/usr/bin/env bash
input=$(cat)
path=$(echo "$input" | jq -r '.tool_input.file_path // ""')
case "$path" in
  */infra/production/*)
    echo "production/ is protected. Change it through the deploy repo." >&2
    exit 2 ;;
esac
exit 0
```

### Format after every edit

Matcher `Write|Edit`, event `PostToolUse`:

```bash
#!/usr/bin/env bash
path=$(cat | jq -r '.tool_input.file_path // ""')
[ -n "$path" ] && npx prettier --write "$path" >/dev/null 2>&1
exit 0
```

> [!CAUTION]
> Hook commands run under **bash on every platform**, including Windows, where
> Git Bash is used. A hook written in `cmd` syntax (`cmd /c "…"`) will appear to
> run and do nothing — the app sees a successful exit and carries on.

> [!IMPORTANT]
> Hooks are read ONLY from your data directory. A `.claude/settings.json` inside
> a project you open is deliberately ignored: otherwise cloning a repository
> would let it run commands on your machine before you had seen a single file.

## Debugging a hook

1. Run it by hand first: `echo '{"tool_name":"Bash"}' | ./audit.sh; echo $?`.
2. Check the exit code is what you think it is — a script that ends with a
   failing `grep` exits non-zero by accident.
3. Confirm the app picked it up: **Reload hooks** reports how many events it
   loaded.
4. A hook that throws or times out never blocks the tool call and never widens
   permissions — the normal gate runs instead.
