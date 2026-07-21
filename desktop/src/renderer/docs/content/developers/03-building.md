---
title: Building and verifying
description: The checks to run before you trust a change.
order: 3
---

```shell
npm run typecheck     # app code only; vendor drift is reported separately
npm run build         # main, preload and renderer bundles
npm run smoke:agent   # runs the real tool pipeline under plain Node
npm run smoke:memory  # memory pipeline, in a throwaway data directory
```

## About the smoke runs

They are not unit tests. They bundle the real code with Electron stubbed and
exercise it end to end: tools actually run, hooks actually fire, permission
decisions are asserted by whether the user WOULD have been asked.

`smoke:memory` runs in a temporary data directory and refuses to start if the
path does not look throwaway — an unguarded run would rewrite your real memory
files.

> [!WARNING]
> Anything that writes to disk outside a test must be run inside Electron or
> with an isolated data directory. The Electron stub resolves the data directory
> from the working directory, so a careless script finds your real one.
