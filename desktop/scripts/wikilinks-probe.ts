/**
 * [[Wikilink]] → link transform: what becomes clickable, and what must not.
 *
 * The dangerous direction is over-matching: `[[0]]` inside a fenced code
 * block or an inline span is an array literal, and turning it into a link
 * corrupts code on screen. The other direction — an alias, a heading ref,
 * an embed — decides whether citations read the way Obsidian users expect.
 *
 *   npm run smoke:wikilinks
 */

import { linkifyWikilinks, vaultRefFromHref, VAULT_SCHEME } from '../src/renderer/lib/wikilinks.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}
const eq = (name: string, got: string, want: string): void =>
  check(name, got === want, { got, want })

// ─── The transform ──────────────────────────────────────────────────────

eq(
  'a plain wikilink becomes a vault link',
  linkifyWikilinks('см [[Attention]] дальше'),
  `см [Attention](${VAULT_SCHEME}Attention) дальше`,
)
eq(
  'an alias shows the alias, carries the target',
  linkifyWikilinks('[[Attention|эту статью]]'),
  `[эту статью](${VAULT_SCHEME}Attention)`,
)
eq(
  'a heading ref travels in the target, not the label',
  linkifyWikilinks('[[Note#Intro]]'),
  `[Note](${VAULT_SCHEME}${encodeURIComponent('Note#Intro')})`,
)
eq(
  'spaces and cyrillic survive the encoding',
  linkifyWikilinks('[[Мои проекты 2026]]'),
  `[Мои проекты 2026](${VAULT_SCHEME}${encodeURIComponent('Мои проекты 2026')})`,
)
check(
  'an embed is not a citation',
  linkifyWikilinks('картинка ![[img.png]] тут').includes('![[img.png]]'),
  linkifyWikilinks('картинка ![[img.png]] тут'),
)
check(
  'two links on one line both transform',
  (linkifyWikilinks('[[A]] и [[B]]').match(/monet-vault:\/\//g) ?? []).length === 2,
)

// ─── Code is untouchable ────────────────────────────────────────────────

{
  const fenced = '```ts\nconst m = x[[0]];\n```\nа [[Note]] снаружи'
  const out = linkifyWikilinks(fenced)
  check('inside a fence nothing changes', out.includes('x[[0]]'), out)
  check('outside the fence the link still lands', out.includes(VAULT_SCHEME), out)
}
{
  const inline = 'код `a[[0]]` и [[Note]]'
  const out = linkifyWikilinks(inline)
  check('inline code spans are skipped', out.includes('`a[[0]]`'), out)
  check('…while prose on the same line transforms', out.includes(`[Note](${VAULT_SCHEME}Note)`), out)
}
eq('text without wikilinks passes through unchanged', linkifyWikilinks('обычный текст [x](y)'), 'обычный текст [x](y)')

// ─── The href round trip ────────────────────────────────────────────────

check(
  'the ref decodes back from the href',
  vaultRefFromHref(`${VAULT_SCHEME}${encodeURIComponent('Мои проекты 2026')}`) === 'Мои проекты 2026',
)
check('a foreign href is not a vault ref', vaultRefFromHref('https://x.dev') === null)

console.log(failures === 0 ? '\nALL WIKILINK CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
