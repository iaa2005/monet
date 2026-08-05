---
title: Permission modes
description: What each mode allows, how "risky" is actually decided, and how to choose per task.
order: 1
---

Every tool call passes a permission check before it runs. The mode sets what
happens when that check is uncertain. Change it from the composer, per chat.

## The five modes

| Mode | Read tools | Edits in workspace | Edits outside | Shell | Risky shell |
| --- | --- | --- | --- | --- | --- |
| **Ask** | run | ask | ask | ask | ask |
| **Accept edits** | run | run | ask | ask | ask |
| **Auto** | run | run | ask | safe run | ask |
| **Plan** | run | blocked | blocked | blocked | blocked |
| **Skip approvals** | run | run | run | run | run |

## What "risky" actually means

It is not a list of tool names. A shell command is parsed — its syntax tree, the
paths it touches, whether it pipes a download into a shell — by the same engine a
professional coding agent uses. So the judgement is per command:

| Command | Verdict |
| --- | --- |
| `echo hi`, `git status`, `ls` | runs, even in Auto |
| `rm -rf build` | asks |
| `curl … ` piped into `sh` | asks |
| `npm install <pkg>` | asks |

This is why Auto is usable: the safe majority of shell work does not interrupt
you, and only the genuinely consequential commands do.

## The one subtlety worth knowing

In **Auto**, file edits run without asking **only inside your workspace**. The
same edit aimed anywhere else on disk still asks. A mode meant to cut friction
must not quietly widen what the agent can reach — so the boundary is the working
directory, enforced by the rules, not by a tool name.

## Allow always

When a prompt appears you can approve just this once, or for the rest of the
session. A session grant is per tool and per chat, and it is cleared when you
reset the chat.

## Which mode to use

- **Ask** — anything unfamiliar, or a repo that matters.
- **Accept edits** — a focused editing session where you trust the direction and
  do not want to confirm each save.
- **Auto** — routine work where you want shell commands judged on their merits.
- **Plan** — a large or risky change you want to see mapped before a line moves.
- **Skip approvals** — a throwaway sandbox, and only while you are watching.

> [!WARNING]
> **Skip approvals** turns off every prompt, including the ones in front of
> destructive commands. Use it deliberately and briefly, never as a default.

## Plan mode end to end

In Plan mode the agent may only read and research; nothing that changes anything
can run. When it is ready it hands you a plan and asks you to approve, approve
with auto-accepted edits, or keep planning with a note. Approving switches the
mode for the rest of that turn, so it starts work straight away rather than
hitting a wall on its next call.

## The pipeline, stage by stage

Under the hood every decision runs through an ordered list of named
policies; the first one with an opinion wins. The order **is** the policy:

| # | Stage | What it decides |
| --- | --- | --- |
| 1 | `reserved-device-deny` | A write to a Windows reserved device name (`nul`, `con`, `prn`, `aux`, `com1–9`, `lpt1–9` — any case, any extension) is refused in **every** mode, bypass included. The model wanted `/dev/null`; the device name is never the file it meant, and on Windows it can leave an undeletable landmine. |
| 2 | `bypass-mode-approve` | Skip-approvals means what it says — everything below is moot. |
| 3 | `plan-mode-guard` | Plan mode blocks anything that is not read-only, outranking even your own session grants. |
| 4 | `sensitive-file-ask` | Credential-shaped files (`.env`, `id_rsa`, `*.pem`, keystores, `.npmrc`, `.aws/credentials`…) get one question **even in Auto** — and even when reached through a shell: `cat .env` is judged like `Read(.env)`. See below. |
| 5 | `session-approval-history` | "Allow always" grants from earlier this session. |
| 6 | `browser-origin` | Browser tools judged by the site they would act on: localhost silent, allow-listed origins silent, everything else asks; running JavaScript always asks. |
| 7 | tool's own rules | Workspace scoping, read-before-edit, user allow/deny lists. A deny here is final. |
| 8–9 | auto-mode stages | Auto approves read-only tools by nature, and writes only where Accept-edits would allow them — path scoping, never a name list. |
| 10 | `fallback-ask` | Nobody had an opinion: ask you, or refuse if the run is unattended. |

### Shell commands are read, not trusted

The sensitive-file stage does not look only at path arguments. A shell
command is walked with quote awareness — chain operators (`&&`, `;`, `|`)
split it so **every** segment is judged, quotes group, and a backslash stays
a Windows path separator. So `ls && cat .env` asks; `git commit -m "update
.env handling"` does not (quoted prose with spaces is a message, not a
path). Approving a secret is **per file**, and a session-wide "always allow
Bash" does not extend to credentials — the sensitive stage sits above the
grant history on purpose.

### What an approved secret means

Nothing more than that one file: the stage answers "may this call touch
this path", then steps aside so every later rule still applies to the call.
An approved secret read is not an approved anything else.
