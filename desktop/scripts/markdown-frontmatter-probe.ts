/**
 * A rule is not metadata.
 *
 * A reply that opens with `---` and uses another `---` further down had
 * everything between them rendered as a yaml code block — headings, bold text
 * and prose, shown as source. So the block now has to READ as YAML, not just
 * sit where YAML sits, and both halves of that are pinned here.
 *
 *   npm run smoke:frontmatter
 */

import {
  splitFrontmatter,
  looksLikeYaml,
} from '../src/renderer/lib/frontmatter.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── Real frontmatter still works ───────────────────────────────────────

const doc = `---
name: docx
description: Word documents
allowed-tools:
  - Read
  - Bash
---

# Heading

Body text.`
const split = splitFrontmatter(doc)
check(
  'a metadata block is still lifted out',
  split.frontmatter === `name: docx\ndescription: Word documents\nallowed-tools:\n  - Read\n  - Bash`,
  split.frontmatter,
)
check('and the body starts after it', split.body.startsWith('\n# Heading'), split.body.slice(0, 20))

check(
  'a comment inside frontmatter is fine',
  splitFrontmatter('---\n# generated\nname: x\n---\nbody').frontmatter === '# generated\nname: x',
)

// ─── The report that broke ──────────────────────────────────────────────

const report = `---

# Аудит проекта Code Monet Desktop

## Общая характеристика

**Code Monet** — десктопное Electron-приложение.

---

## 1. Критические

### 1.1 Молчаливое проглатывание ошибок`
const r = splitFrontmatter(report)
check(
  'an opening rule is NOT frontmatter',
  r.frontmatter === null,
  r.frontmatter,
)
check('so the whole document survives as markdown', r.body === report)

check(
  'a rule with a bare sentence after it is not frontmatter either',
  splitFrontmatter('---\nJust a sentence.\n---\nmore').frontmatter === null,
)

check(
  'a rule directly above a heading is not frontmatter',
  splitFrontmatter('---\n# Title\n---\ntext').frontmatter === null,
)

// A colon in prose is the trap: "Итог: всё готово" is a sentence, not a key.
check(
  'prose that happens to contain a colon is not YAML',
  looksLikeYaml('Итог: всё готово, но есть нюанс — смотри ниже.\nВторая строка прозы.') === false,
)

check('an empty block is not YAML', looksLikeYaml('') === false)
check('a block with no key at all is not YAML', looksLikeYaml('- one\n- two') === false)
check('one key is enough', looksLikeYaml('name: x') === true)

// ─── Documents without any of this ──────────────────────────────────────

check(
  'no leading rule: nothing is touched',
  splitFrontmatter('# Title\n\ntext').frontmatter === null,
)
check(
  'an unterminated opening rule leaves the text alone',
  splitFrontmatter('---\nname: x\nno closing rule').frontmatter === null,
)
check(
  'CRLF is the same document',
  splitFrontmatter('---\r\nname: x\r\n---\r\nbody').frontmatter === 'name: x',
)

console.log(failures === 0 ? '\nfrontmatter probe OK' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
