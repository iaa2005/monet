---
title: The sandbox
description: Where Home runs code, and what "isolated" actually means.
order: 7
---

In Home the agent has no access to your filesystem or shell. It gets a sandbox
instead: a per-chat working area where it can write files and run code.

## Per chat

Each conversation has its own sandbox. Files the agent creates in one chat are
not visible in another — nothing accumulates across unrelated work, and deleting
a chat takes its sandbox with it.

## The tools

- **RunPython** — execute Python and see the output.
- **RunCommand** — run a shell command inside the sandbox (container engines).
- **SandboxList / SandboxRead / SandboxWrite / SandboxEdit** — the sandbox's own
  filesystem, with paths confined to the working area.

## Engines

The engine decides what "isolated" means, and can be changed globally or per
chat in **Settings → Sandbox**.

**Pyodide** (default) — Python compiled to WebAssembly, inside the app process.
Nothing reaches the host at all; the cost is that native packages are limited to
what is compiled for it.

**Subprocess** — a real Python on your machine. Full package support, weaker
isolation: it is a process on your system.

**Podman/Docker** — a real container. Strong isolation with full package
support; needs a container runtime installed.

> [!NOTE]
> Attachments you send in Home are copied into that chat's sandbox, which is how
> a model without file support can still work with them: it reads the file
> through the sandbox tools instead of seeing it inline.
