---
title: The data directory
description: Everything the app stores, and where.
order: 2
---

All state lives in one directory. Nothing is written to `~/.claude` — the
vendored agent's config home is redirected here too, so your own installation of
any other agent tooling is untouched.

| Path | What it is |
| --- | --- |
| `sessions.db` | Chats, messages, routines, run history |
| `claude/memory/` | Memory files, `MEMORY.md` index, daily logs |
| `prompts/*.md` | Every editable prompt |
| `hooks.json` | Your hooks |
| `providers.json` | Providers; keys encrypted by the OS keystore |
| `model-routing.json` | Background model choice |
| `memory-config.json` | Memory settings |
| `memory-consolidation.json` | Nightly pass state |
| `artifacts/`, `sandboxes/` | Files produced by chats |

> [!TIP]
> The whole directory is portable. Copy it to move an installation, or point the
> app at a different one with a `monet-bootstrap.json` containing `{"dataDir":
> "..."}`.
