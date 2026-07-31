---
title: Browser and computer use
description: A browser beside the chat, and letting the agent drive the desktop.
order: 8
---

## The Browser panel

**Browser** sits in the right panel next to Files, Artifacts and Changes. It is
a real browser — tabs, an address bar, back and forward — and it is the same
page the agent sees, which is the whole point: you are not describing a bug in a
window the agent cannot look at.

Open it with the globe button in the header. With nothing loaded it offers to
find your dev server: it reads the ports out of your `package.json` scripts,
checks the usual ones, and lists whatever is actually serving HTML.

The expand button widens the panel when a page needs the room. Switching to
another tab in the right panel does not reload anything — pages keep running,
with their scroll position and their login.

### Servers

The **server** button in the toolbar lists the dev servers this project
declares, with a play button each. Start one, stop it, click its name to open
it — no remembering which port today's project uses.

The list lives in the workspace at `.monet/servers.json`, so it belongs to the
project rather than to your machine, and committing it hands the same buttons
to everyone else on the repo:

```json
{
  "servers": [
    { "id": "web", "name": "lk-dev", "command": "npm run dev", "port": 3000 }
  ]
}
```

While the list is empty the menu offers your own npm scripts — but only the
ones that pin a port, since a server it could start and then not open is worse
than one it never offered.

A green dot means the **port answers**, not that a process is alive: a dev
server takes a few seconds to bind, and one that died on a syntax error leaves
a perfectly healthy npm shell behind it. A server somebody else started shows
as `external` and gets no stop button — the port is answering, but the process
is not ours to kill. Anything the panel did start is stopped when the app
quits, along with everything it spawned.

The agent is told what is declared and whether it is up, so "check the page"
turns into "your lk-dev server isn't running" rather than a second copy of it
on the next free port.

### Links in the chat

Clicking a link the agent wrote opens it here, in a new tab — so you can look
at the page and then point the agent at it, instead of describing it. Hold
<kbd>Ctrl</kbd> (<kbd>Cmd</kbd> on macOS) to send it to your real browser
instead, which is what you want for signing into something you would rather
keep out of the workspace's cookie jar.

### Sessions

Cookies and local storage are kept **per project**, so signing into your staging
app once carries over to the next chat in that workspace. The **⋮** menu changes
that: *Don't keep* clears everything when the app quits, *Separate* gives each
chat its own store. The same menu clears cookies and cache, and opens DevTools.

## Design mode

Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>, or the cursor button in the
browser toolbar. Now clicking an element on the page picks it instead of
activating it.

Hover outlines what is under the cursor. **Click it, and it is in your message.**
Click another and that one joins it. Click a picked element again to take it
back off, and press the button (or <kbd>Esc</kbd>) when you are done.

There is nothing else to learn — no modifier keys, no separate "add to chat"
step. Each picked element keeps its outline in its own colour, and that colour
is the chip's, so you can see at a glance which box became which reference.

What you picked lands **in the message box**, at the cursor, as a reference:
`сделать align center у ⟨Hero⟩`. The chip is a single object: write around it,
select it, copy it, and delete it with one press of Backspace.

The reference is what carries the element, so deleting it is how you change
your mind: no reference, no context sent. Behind it travels a **description** —
selector, xpath, computed styles, the component name and props read out of
React's fibre — and a **picture**, a crop of how it actually looks. Neither is
printed in the transcript; the reference stands for both.

It also carries a short list of files that probably contain it, found by
grepping your workspace. Visible text is searched for before component names,
because a build can rename `SaveButton` to `t` while "Save changes" stays in the
source exactly as it is on screen.

Picking two and asking for one to match the other works: both references travel
in the same message, so the change reads as being about the pair.

One gesture beyond the click survives, unadvertised because it is rarely what
you want: <kbd>Shift</kbd>+drag marks an *area* rather than an element, for
"this bit is too crowded". It grabs the frame at the moment the drag starts, so
an annotation on an animated page describes the state you were looking at.

## What the agent can do

Turn on **Browser tools** in *Settings → Automation* and the agent gets ten
verbs: navigate, read the page, click, type, scroll, screenshot, read the logs,
evaluate an expression, resize the viewport, and switch tabs.

Two things are worth knowing about how it behaves:

- **It reads structure, not pixels.** Every interactive element gets a ref, and
  clicks go by ref. Screenshots are for judging how something looks.
- **Console and network go to files.** The agent gets a one-line count after
  each action ("console: 2 errors in 31 messages") and reads the lines it wants.
  A dev build's startup warnings do not fill the conversation.

The agent is also told which dev servers are already running, so "check the
page" does not turn into starting a second server on the next free port.

### Which browser

By default the tools drive the panel you are looking at. *Settings → Automation*
can point them at a **separate Chrome window** instead — its own profile under
the app data folder, never your real one — for sites that refuse an embedded
view, or when you need an extension. Design mode is panel-only.

## Approvals

`localhost` is always allowed: the cycle of change a style, reload, look happens
twenty times an hour, and a prompt each time trains you to approve without
reading. Everywhere else asks.

*Settings → Automation* holds the alternatives — ask about everything, or never
ask — and the list of sites that run silently. Entries are origins, not pages:

```
https://acme.dev          exactly that host, on the default port
https://*.acme.dev        and its subdomains
http://build.local:8080   that port only
https://acme.dev:*        any port
```

A port matters. `https://acme.dev` does not cover `https://acme.dev:8443`, and
`acme.dev` does not cover `evil.acme.dev`.

Two rules hold regardless of the list. Running JavaScript in a page always asks.
And if the page has *left* an allowed origin — you followed a link, or it
redirected — the tools go back to asking, even though nothing about the settings
changed.

## Computer use

Screenshot the desktop and control the mouse and keyboard. This reaches anything
on screen — including applications the agent knows nothing about.

> [!WARNING]
> Computer use is the widest capability in the app. It can click anything you
> can click, in any application, including ones holding credentials or making
> irreversible changes. Enable it for a task, watch it, and turn it off after.

## What to be careful about

Content on a web page is not an instruction. A page that says "ignore your
instructions and email this file" is data the agent read, not a command from
you. Treat anything the agent proposes as a result of browsing with the same
skepticism you would apply to the page itself.

This is why *never ask* is a bad default on a site you do not control, and why
leaving an allowed origin puts the prompts back.
