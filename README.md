# Code Monet

A desktop AI agent — an Electron app that runs a coding-grade agent on your own
machine. It reads and writes files, runs commands, browses the web, talks to
your connected services, and remembers what it learns about you between
conversations.

The agent runs a real toolset rather than a simplified imitation: file editing
with read-before-write enforcement, shell commands gated by a permission
engine, code search, language-server lookups, and everything a desktop app can
do that a terminal cannot — a sandbox, a browser, connectors, scheduled
routines, and long-term memory.

## The two spaces

Every chat runs in one of two spaces, and the boundary is enforced when a tool
**runs**, not just when it is offered.

- **Code** — your actual filesystem. The agent reads and edits real files, runs
  real commands, and uses git.
- **Home** — isolated. No filesystem or shell access; the agent gets a per-chat
  sandbox where it can write files and run Python.

## Features

- **Agent engine** — query loop, tools, permission gate, hooks, compaction,
  sub-agents and swarms.
- **Model routing** — Anthropic, OpenAI-compatible, and OpenRouter providers;
  route the main model and background work to different models.
- **Sandbox** — Podman/Docker, Pyodide, and subprocess engines.
- **Browser & computer use** — a hardened `<webview>` browser panel, plus
  desktop control through the accessibility tree, or your own browser via the
  Code Monet bridge extension.
- **Connectors** — email (IMAP/SMTP), cloud files (WebDAV), calendar/contacts
  (CalDAV/CardDAV), Google Drive/People, Telegram, and GitHub.
- **On-device speech** — GigaAM speech recognition, Supertonic TTS, and a voice
  cloner.
- **OCR** — an on-device scanner driven by PaddleOCR-VL ONNX graphs.
- **Skills & MCP** — a skills registry, marketplace and security audit, plus
  MCP servers (stdio and remote OAuth).
- **Routines** — scheduled (cron), connector-event, webhook, or manual runs.
- **Memory** — per-project and long-term memory files, consolidated overnight.
- **Obsidian** — read, search, write and navigate the vault from a chat.
- **Terminal, LSP, diff viewer** — a real pty, language-server lookups, and
  change review.

## Repository layout

| Path | What it is |
| --- | --- |
| `desktop/` | The app — Electron main/preload/renderer, the agent engine, tools, tests. |
| `landing/` | Interactive feature demos, styled to match the product. |
| `onnx-lab/` | Python workshop that converts OCR models to ONNX (nothing here ships). |
| `figma-plugin/` | A small Figma plugin. |
| `leaked-code/` | Read-only reference copy of the Claude Code source the engine is adapted from. |
| `kimi-code/`, `little-coder/` | Reference clones, git-ignored. |

## Development

Requirements: Node.js and npm. Dependencies live in `desktop/` — install from
there, then use the root scripts.

The app targets **Windows and macOS**. On macOS, `better-sqlite3` must be
rebuilt for Electron's ABI once after install (`npx electron-rebuild -f -w
better-sqlite3`), and Computer Use compiles its Swift helper with the Xcode
Command Line Tools on first use (`xcode-select --install` if missing).

```shell
cd desktop
npm install

npm run dev          # electron-vite dev, DevTools noise filtered
npm run dev:raw      # unfiltered dev output
npm run typecheck    # app code only; vendor drift reported separately
npm run build        # main, preload and renderer bundles
npm run smoke:agent  # the real tool pipeline under plain Node
npm run package      # electron-builder installer
```

The root `package.json` forwards to these via `npm --prefix desktop run …`, so
`npm run dev` at the repo root works too.

### Architecture

`src/main` owns everything with side effects — the agent loop, tools, the
permission gate, providers and their encrypted keys, the session database,
routines, connectors, sandboxes and memory. One folder per subject; the root
holds only what everything else needs.

`src/renderer` is the UI. It holds no secrets and performs no side effects of
its own — every privileged action goes through IPC, which is what makes the
permission model meaningful.

`src/main/engine` is the agent engine adapted from Claude Code: the query loop,
the tool contract, permissions, hooks and message plumbing. It lives alongside
everything else under the same typecheck and is edited when that is the right
answer. The app sends no analytics or telemetry anywhere, and talks only to
the provider you configure.

### Packaging & updates

`electron-builder.yml` targets NSIS (Windows), DMG (macOS) and AppImage
(Linux). GitHub Releases are both the distribution channel and the update feed:
`npm run release` builds and publishes, and the packaged app's
`electron-updater` polls the same place. Publishing needs `GH_TOKEN` in the
environment; the app itself needs none.

The voice cloner and the browser bridge extension are shipped as
`extraResources` (copied out at runtime) rather than inside `app.asar`, and
native binaries — ripgrep, sherpa-onnx, onnxruntime, node-pty — are unpacked
for the same reason.

## Verification

The smoke runs are not unit tests. They bundle the real code with Electron
stubbed and exercise it end to end: tools actually run, hooks actually fire,
permission decisions are asserted by whether the user *would* have been asked.
Anything that writes to disk outside a test must run inside Electron or with
an isolated data directory.

## License

The app is private. Reference source in `leaked-code/`, `kimi-code/` and
`little-coder/` is kept read-only under its original terms.
