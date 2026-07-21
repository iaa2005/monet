---
title: Editing the prompts
description: Every instruction the agent receives is a file you can change.
order: 4
---

The system prompt, the mode directives, the working-discipline block and every
tool description are Markdown files in `prompts/` inside the data directory.

- Edit a file to change what the agent is told.
- Delete a file to restore its default.
- Changes apply on reload.

This is the deepest customisation the app offers, and the easiest to get wrong:
tool descriptions in particular are load-bearing. Keep a copy of anything you
edit heavily, and remember that deleting the file is always a clean way back.
