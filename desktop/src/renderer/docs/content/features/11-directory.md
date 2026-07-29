---
title: Directory
description: One place to browse and install skills, connectors and MCP servers.
order: 11
---

Everything that extends the app is installed from the same window. Open it from
**your name → Directory** at the bottom of the sidebar, or from the *Browse the
Directory* button in Settings → Skills, Connectors and MCP Servers — those open
the Directory already on the matching section.

The left rail picks the section; the search box, the source chips and the
**Filter by** / **Sort by** menus apply to whichever section you are on.

## Skills

A skill is any folder in a GitHub repository that contains a `SKILL.md`. The
Directory reads the frontmatter of each one for its name and description.

**Sources** are the repositories it reads. The default is
`iaa2005/monet-directory/skills`. Add your own with **Add repo** in the chips row:

| You type | It becomes |
| --- | --- |
| `owner/repo` | that repository, whole |
| `owner/repo/skills` | only the `skills/` subfolder |
| `https://github.com/owner/repo` | `owner/repo` |
| `https://github.com/owner/repo/tree/main/skills` | `owner/repo/skills` |

Sources merge into one grid, and every card is labelled with the repo it came
from — so two repos may both offer a `pdf` skill and you can see which is
which. Click a chip to show only that source; the ✕ on a chip removes the
source. The list is stored in `skill-store.json` in your data directory.

**Installing** downloads that one folder — `SKILL.md`, `scripts/`,
`reference.md`, anything else it holds — into `claude/skills/<name>` in your
data directory, and the agent picks it up immediately. A name already taken
gets a numeric suffix rather than overwriting. The bin icon on an installed
card deletes the local copy.

> [!NOTE]
> Private repositories are not supported: the catalogue is read with
> unauthenticated GitHub requests. A private repo reports "not found".

Listing a repo costs one GitHub API call and is cached for ten minutes. If you
add many repos and see a rate-limit error, wait a few minutes — the ✕ on a
chip and the reload button next to the filters both help.

## Connectors

Two kinds share the grid, and the **Built-in** / **monet-directory** chips
separate them:

- **Built-in** services are compiled into the app. There is nothing to install
  — *Connect* opens the sign-in form directly.
- **Community** connectors are manifests from
  `github.com/iaa2005/monet-directory`. Those need installing first.

Installing a community connector always shows a confirmation listing **every
endpoint the manifest may talk to** before anything is written. Read it: the
manifest decides where your credential is sent, so those hosts should belong to
the service you think you are connecting. Permissions start at the standard
matrix — reads allowed, writes ask — and are editable afterwards in Settings →
Connectors.

The **Connectors** page covers what happens after connecting — accounts,
per-action permissions, and how they behave in a routine.

## MCP servers

This section searches the official registry at
`registry.modelcontextprotocol.io` — thousands of servers, so the search box
queries the registry itself rather than filtering a page. **Filter by**
separates local (stdio) servers from remote (http/sse) ones.

**Add** never installs anything on its own. It opens the normal *Add
connector* form, pre-filled from the registry entry, so that before you save:

- the exact **command line** is on screen for a local server — it runs on your
  machine, so read it;
- the exact **URL** is on screen for a remote one;
- any environment variables or headers the server declares are listed as empty
  rows for you to fill in. Secrets are typed by you, into your own config.

Some entries carry a `<placeholder>` in the arguments — for example
`<allowed-directories>`. That is the registry naming a slot it cannot fill: the
publisher declared a required argument without a value. Replace it before
saving, or the server will not start. The note above the form tells you which
ones.

A few registry entries cannot be launched at all — published only in a format
the app has no launcher for, or with no package and no endpoint. Those are
greyed out with the reason, and offer only a link to their repository.

*Add by hand* opens the same form empty, for a server you already know.

Servers you have added appear at the top of the section with their live
connection status and tool count.

> [!IMPORTANT]
> An MCP server you add by hand is arbitrary code or an arbitrary endpoint. It
> is treated as such: its tools ask before every use, and it is not offered in
> Home. The **MCP servers** page has the details.
