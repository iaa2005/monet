---
title: The data directory
description: Everything the app stores, where it lives, and how to move or isolate it.
order: 2
---

All state lives in one directory. Nothing is written to `~/.claude` — the
vendored agent's config home is redirected here too, so any other agent tooling
you have installed is untouched.

## Where it is

In a packaged build, `.monet` inside the platform's per-user application data:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\Code Monet\.monet` |
| macOS | `~/Library/Application Support/Code Monet/.monet` |
| Linux | `~/.config/Code Monet/.monet` |

In development it is `.monet` beside the app folder instead. **Settings →
Advanced** shows the resolved path.

## What is in it

| Path | What it is |
| --- | --- |
| `sessions.db` | Chats, messages, routines, run history (SQLite) |
| `claude/memory/` | Memory files, `MEMORY.md` index, daily logs |
| `prompts/*.md` | Every editable prompt |
| `hooks.json` | Your hooks |
| `providers.json` | Providers; keys encrypted by the OS keystore |
| `model-routing.json` | Background-model choice |
| `memory-config.json` | Memory settings |
| `memory-consolidation.json` | Nightly-pass state |
| `lean-context.json` | Advanced toggles |
| `artifacts/`, `sandboxes/` | Files produced by chats |

API keys are **not** in `providers.json` in readable form — they go through the
OS keystore (DPAPI / Keychain). Everything else is plain text and safe to read.

## Moving an installation

The whole directory is portable. Copy it to a new machine's location above and
the app picks up every chat, routine, memory and setting.

## Pointing at a different directory

Put a `monet-bootstrap.json` next to the default location:

```json
{ "dataDir": "D:/monet-data" }
```

The app reads that at startup and uses the directory it names. Two uses:

- **A portable install** — keep everything on an external drive.
- **A separate profile** — a clean data directory for testing, without
  disturbing your real one.

> [!WARNING]
> This is also the mechanism the test harness uses to stay away from your real
> data. A script that writes to the default directory by accident can overwrite
> your memory and chats — anything writing outside the app should point
> `dataDir` at a throwaway folder first.
