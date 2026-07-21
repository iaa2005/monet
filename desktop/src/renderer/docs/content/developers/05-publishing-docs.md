---
title: Publishing these docs
description: The same folder can become a public website unchanged.
order: 5
---

The pages you are reading are plain Markdown with YAML frontmatter, in
`src/renderer/docs/content`. The in-app reader is only a reader — nothing about
the content is app-specific.

## The structure

- One folder per section; `_section.md` carries its title and order.
- One file per page, with `title`, `description` and `order`.
- A numeric filename prefix (`01-`) orders files on disk and is stripped from
  the slug, so URLs stay clean.
- Callouts use GitHub's alert syntax (`> [!NOTE]`, `> [!WARNING]`), which
  Docusaurus, VitePress and GitHub itself all render natively.

## To publish

Point any static site generator at the folder. Nothing needs rewriting — the
frontmatter fields are the conventional ones, and no custom directives are used.
