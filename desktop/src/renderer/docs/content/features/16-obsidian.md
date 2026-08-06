---
title: Obsidian vaults
description: Your knowledge base as a first-class citizen — searched, navigated by wikilinks, cited, and written only on request.
order: 16
---

**Settings → Obsidian** connects your Obsidian vaults to the agent. A vault
is just a folder of linked Markdown notes — it can live anywhere, including
inside a cloud-sync folder; the app keeps a pointer, never a copy. Any
folder of `.md` files works; a real vault (with `.obsidian/` inside) is
detected and labelled.

## What the agent can do with a vault

These tools appear the moment a vault is enabled — and only then:

- **VaultSearch** — names, aliases, tags and full text, with `tag:x` and
  `link:Note Name` filters (the latter finds notes that link *to* a note).
- **VaultRead** — one note by its **wikilink name** (not a file path), with
  its outgoing links and backlinks, so the agent navigates the vault the
  way the vault is written: by following `[[links]]`.
- **VaultWrite** — create, append, replace or **trash**; refused entirely
  in a read-only vault; atomic on disk so a sync client never sees a
  half-written note. Trash is the only removal there is: the note moves
  into the vault's own `.trash/` folder, recoverable from Obsidian —
  a hard delete of your writing is not an operation the agent has.
- **VaultEdit** — change *part* of a note: exact old text in, new text out.
  The surgical counterpart of VaultWrite, which can only append or rewrite
  the whole file. The old text must match exactly and must be unique unless
  `replace_all` is passed, so a one-line fix can never quietly hit five
  places.
- **VaultMove** — move or rename a file, notes and attachments alike, and
  **rewrite the `[[links]]` that point at it**. This is how loose pictures
  get tidied out of the vault root without any embed going dead. A move
  that keeps the name touches no note at all — Obsidian resolves links by
  name, not by path — and a rename reports how many references it updated.

## Files, not just prose

**VaultAttach** puts an image, a video, a PDF — anything — into the vault
and hands back the embed that references it. It works from **either
space**: name a file from this chat's sandbox in Home, a workspace path in
Code, or an artifact path from a tool result anywhere (a screenshot, a
generated chart, a file you attached to a message).

The copy lands in **your vault's own attachment folder**. Where that is,
in order: the **Attachments** field on the vault's card in Settings if you
filled it in, otherwise the vault's own `.obsidian/app.json` — including
the per-note form (`./assets`, beside the note). Set the field on a vault
whose pictures currently land in the root and every new attachment goes to
the folder you named instead; the ones already there move with VaultMove.

A name that already exists gets a suffix rather than clobbering anything,
and the copy is atomic, so a sync client never sees half a picture. Only
the characters a filesystem actually forbids are replaced — a hyphen or a
space in `00-cover.jpg` survives, so the embed the tool reports back is the
name that is really on disk.

Pass a note and the embed lands there in one step. Pass **`replace`** as
well — the exact text it should take the place of, a markdown image, a URL,
a placeholder line — and the picture goes *where the text talks about it*
instead of at the end of the note.

Images, video and audio come back as `![[name]]` embeds; other kinds as
`[[name]]` links. **The app renders those embeds**: open a note in the
viewer and the picture is a picture, the video plays, the PDF is a button
that opens it.

## The protocol

While a vault is connected, the agent carries standing rules:

1. **Search first** — questions that may touch your notes are checked
   against the vault before general knowledge answers them.
2. **Read narrowly** — the 2-3 most relevant notes, following wikilinks;
   the vault is a retrieval store and is *never* loaded into the model
   wholesale, whatever its size.
3. **Cite** — answers drawn from notes name them as `[[wikilinks]]`.
4. **Write only on request** — the vault is *your* writing. The agent
   creates or changes notes only when you ask it to save something, prefers
   appending to an existing note over spawning a near-duplicate, always
   links new notes into the graph — and every write goes through the normal
   permission prompt, like any file change outside the workspace.

Ambiguity is never resolved silently: two notes sharing one name come back
as a choice of explicit paths.

Cited notes render as clickable chips in the chat: click opens the note in
the app's viewer (markdown rendered, wikilinks inside it clickable too),
Ctrl+click opens it in the Obsidian app itself.

## Canvas and Bases

`.canvas` boards and `.base` tables are first-class vault citizens: they
index under their bare name, their cards and embedded notes join search
and backlinks, and reading a canvas returns its CONTENT — groups, cards,
referenced notes as wikilinks — rather than raw JSON. The viewer renders
a canvas the same way. They are structured formats made in Obsidian, so
the agent can read and trash them but never text-edits them.

## The workflow skills

Three built-in skills package the classic knowledge-base loops (type `/` to
run them):

- **/wiki-query** — answer strictly from the vault, citing every note used,
  and say plainly when the vault does not cover the question.
- **/wiki-ingest** — turn a URL, pasted text or file into notes that *join*
  the graph: one note per concept, tags from your existing vocabulary,
  wikilinks to related notes, a Source line for traceability.
- **/wiki-lint** — a health report first (dead links, orphans,
  near-duplicates, inconsistent frontmatter), repairs only for the items
  you pick.

## Vault vs Memory

They are different organs, on purpose. **Memory** is what the agent learns
about you by itself — implicit, app-owned, injected into every chat. The
**vault** is the knowledge base you author — explicit, yours, living where
you put it, consulted by retrieval and written only on request. The agent
may cite your notes in answers and may propose "this is worth a note", but
it never transcribes conversations into your vault on its own.

## Cloud folders

Supported deliberately: the index refreshes from disk on every use (no
watcher fighting your sync client), and writes are atomic, so Drive /
OneDrive / Syncthing never see partial files. If a cloud folder is
unmounted, the vault shows "folder not found" in Settings and simply drops
out of the tools until it returns.
