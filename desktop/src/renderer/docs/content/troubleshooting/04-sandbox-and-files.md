---
title: Sandbox, files and permissions
description: Podman that will not start, writes that get refused, and questions the app asks about files.
order: 4
---

## Run Python does nothing / Podman is not ready

The container engine (Settings → Sandbox → Podman) provisions itself on
first use: the portable CLI downloads, the Linux backend (WSL2 on Windows)
initialises, the shared image builds. That first run takes minutes and the
button reports each stage.

- **"WSL2 isn't installed yet"** (Windows) — run `wsl.exe --install` in a
  terminal, reboot if Windows asks, then click *Install / prepare* again.
- **macOS** — the CLI is not downloaded for you: install it with
  `brew install podman`, then `podman machine init && podman machine start`.
  The Subprocess engine on macOS additionally confines every run with the
  system sandbox (Seatbelt): writes outside the chat's folder are refused.
- Stuck at machine start: a leftover machine from a previous run can wedge
  it; *Install / prepare* again is safe — provisioning is idempotent.
- Not ready is never silent failure of your message: the tool result says
  what is missing, and Pyodide (the default engine) needs no setup at all.

## Which engine am I actually in?

| Engine | Isolation | Power |
| --- | --- | --- |
| **Pyodide** (default) | full — WebAssembly inside the app, no file or network access | pandas, matplotlib, docs/tables/charts |
| **Local subprocess** | none — real python/node on your machine | everything, use only with models you trust |
| **Podman** | container | real Python + Node + LaTeX |

Per-chat override: the picker in the title bar (Home). Files carry over
when you switch; only the runtime changes.

## "…may hold credentials" — the app asked about a file the model touched

Working as designed. Credential-shaped files (`.env`, private keys,
keystores, `.npmrc`, cloud credentials) are worth one question even in Auto
mode — and the question fires whether the model used a file tool **or a
shell command** (`cat .env` counts). Approval is per file, per session.
Search never surfaces these files at all: grep and glob exclude them
unconditionally, so the model cannot stumble into a secret it did not name.

## "X is a Windows reserved device name"

The model tried to write to `nul`, `con`, `aux`, `com1`… — usually meaning
it wanted `/dev/null`. The write is refused in every mode (bypass included)
because such a file, once created, breaks the repo for every Windows clone
and can be nearly impossible to delete. The refusal text tells the model
what to use instead; no action needed from you.

## An attachment "was saved to the workspace" instead of being read

The current model cannot consume that kind of file inline (a vision-less
model and a PNG, any model and a .zip). The file lands in the chat's
sandbox (Home) or `.monet-attachments/` in the workspace (Code), and the
model is told the path and how to get at the contents with its tools. To
have images *seen* natively, use a model whose modalities include images.

## Binary attachments cap

Attachments over 20 MB are not inlined (base64 inflates them ~1.37× and the
whole thing travels through the model's context) — they are replaced with a
placeholder note. Put big files in the workspace and let the agent read
them with its tools instead.

## Auto mode edited a file without asking / asked when I did not expect it

The boundary is the **workspace**: in Auto, edits inside the working
directory run silently, the same edit anywhere else on disk asks. This
comes from path scoping, not tool names — so it cannot be widened by a tool
being renamed or a new write-capable tool appearing.
