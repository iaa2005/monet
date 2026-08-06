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

import {
  linkifyWikilinks,
  vaultEmbedFromHref,
  vaultRefFromHref,
  VAULT_EMBED_SCHEME,
  VAULT_SCHEME,
} from '../src/renderer/lib/wikilinks.js'
import { promoteDisplayMath } from '../src/renderer/lib/display-math.js'
import { midEllipsis } from '../src/renderer/lib/utils.js'

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
{
  // An embed is not a citation — it is the FILE. The "!" survives in front
  // of the rewritten link, so markdown parses the result as an image and
  // the renderer swaps in the real picture (VaultEmbed).
  const out = linkifyWikilinks('картинка ![[img.png]] тут')
  eq(
    'an embed becomes an image reference, not a note link',
    out,
    `картинка ![img.png](${VAULT_EMBED_SCHEME}img.png) тут`,
  )
  check('and never through the note scheme', !out.includes(VAULT_SCHEME), out)
  check(
    'the attachment name decodes back',
    vaultEmbedFromHref(
      `${VAULT_EMBED_SCHEME}${encodeURIComponent('моё фото.png')}`,
    ) === 'моё фото.png',
  )
  check(
    'a note link is not an embed',
    vaultEmbedFromHref(`${VAULT_SCHEME}Note`) === null,
  )
}
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

// react-markdown sanitises unknown schemes to "" — and a bare <a href="">
// click reloads the whole SPA. The viewer's urlTransform must let the vault
// scheme through while leaving the default sanitiser in charge of the rest.
{
  const { defaultUrlTransform } = await import('react-markdown')
  const url = `${VAULT_SCHEME}Note`
  check(
    'the STOCK sanitiser really does eat the vault scheme (the bug this guards)',
    defaultUrlTransform(url) === '',
    defaultUrlTransform(url),
  )
}

// ─── Display math promotion (same preprocessing pipeline) ───────────────
//
// remark-math reads single-line $$…$$ as INLINE math, so the centring the
// user expects never happens. A line that is nothing but one formula is
// promoted to the fenced form; everything else must stay untouched.

eq(
  'a lone $$formula$$ line becomes a display block',
  promoteDisplayMath('До\n$$E=mc^2$$\nПосле'),
  'До\n$$\nE=mc^2\n$$\nПосле',
)
eq(
  'inline math inside a sentence stays inline',
  promoteDisplayMath('энергия $$E=mc^2$$ по Эйнштейну'),
  'энергия $$E=mc^2$$ по Эйнштейну',
)
eq(
  'already-fenced math is not double-fenced',
  promoteDisplayMath('$$\nE=mc^2\n$$'),
  '$$\nE=mc^2\n$$',
)
check(
  'code fences are untouched',
  promoteDisplayMath('```\n$$x$$\n```').includes('```\n$$x$$\n```'),
)
eq(
  'two dollar-groups on one line are prose, not a formula',
  promoteDisplayMath('$$5$$ и ещё $$10$$'),
  '$$5$$ и ещё $$10$$',
)
check(
  'indentation survives the promotion',
  promoteDisplayMath('  $$x+1$$').startsWith('  $$\n  x+1\n  $$'),
  promoteDisplayMath('  $$x+1$$'),
)

// ─── Middle ellipsis (dock tabs) ────────────────────────────────────────
//
// For file names the TAIL is the informative part; CSS truncate eats it.

check('short names pass through', midEllipsis('Note.md', 24) === 'Note.md')
{
  const long = 'Very long note about transformers.md'
  const cut = midEllipsis(long, 24)
  check('long names keep head AND tail', cut.length === 24 && cut.includes('…'), cut)
  check('…and the extension survives', cut.endsWith('.md'), cut)
  check('the original is recognisable from the head', cut.startsWith('Very long'), cut)
}

console.log(failures === 0 ? '\nALL WIKILINK CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
