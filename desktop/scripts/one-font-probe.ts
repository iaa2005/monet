/**
 * Two faces, and no third one hiding.
 *
 * The app is meant to have exactly two typefaces: Bounded for display and
 * Inter for everything else. Two ways a third had crept in anyway, both
 * invisible in review:
 *
 *   - A DEAD @font-face. Galaxie Copernicus was declared and shipped, sitting
 *     behind Bounded in the display stack — where a bundled face never yields,
 *     so it rendered nowhere and cost a download.
 *   - A LIVE default. Tailwind's `font-serif` resolves to Georgia unless the
 *     theme says otherwise, and five call sites used it: the Reflect headline,
 *     its stat numbers, the skill titles, a painting's title. None of those is
 *     Bounded and none of them is Inter.
 *
 * So this checks the rule rather than the symptom: every font file is
 * referenced, every reference resolves, and nothing reaches for a family the
 * stylesheet does not define.
 *
 *   npm run smoke:onefont
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

const CSS = resolve('src/renderer/styles/globals.css')
const FONTS = resolve('src/renderer/fonts')
const css = readFileSync(CSS, 'utf-8')

// ─── The stylesheet ─────────────────────────────────────────────────────

const families = [...css.matchAll(/@font-face\s*{[^}]*font-family:\s*"([^"]+)"/g)].map(
  (m) => m[1],
)
check('ONE bundled face, and it is Bounded', families.length === 1 && families[0] === 'Bounded', families)

const display = /--font-display:\s*([^;]+);/.exec(css)?.[1]?.trim() ?? ''
check('the display variable leads with it', display.startsWith('"Bounded"'), display)
check('and names no other webfont behind it — only system fallbacks',
  !/Copernicus|Galaxie/i.test(display), display)

const sans = /--font-sans:\s*([^;]+);/.exec(css)?.[1] ?? ''
check('the UI face is Inter', sans.trim().startsWith('"Inter"'), sans.trim().slice(0, 40))

// ─── The files ──────────────────────────────────────────────────────────

const onDisk = readdirSync(FONTS).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f))
const referenced = [...css.matchAll(/url\("\.\.\/fonts\/([^"]+)"\)/g)].map((m) => m[1])
check('every reference resolves to a file', referenced.every((f) => existsSync(join(FONTS, f))), {
  referenced,
  onDisk,
})
check(
  'AND EVERY FILE IS REFERENCED — a shipped face nothing uses is the bug this had',
  onDisk.every((f) => referenced.includes(f)),
  { onDisk, referenced },
)

// ─── The call sites ─────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'vendor' || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|css)$/.test(e.name)) out.push(p)
  }
  return out
}

const sources = walk(resolve('src/renderer'))

/** Comments are where the RULE is written down — including in this file's own
 * stylesheet — so they must not trip the rule. */
const code = (f: string): string =>
  readFileSync(f, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const serif = sources.filter((f) => /\bfont-serif\b/.test(code(f)))
check(
  'NOTHING ASKS FOR font-serif — that is Georgia, a third face by accident',
  serif.length === 0,
  serif.map((f) => f.replace(resolve('.'), '')),
)
const ghost = sources.filter((f) => /copernicus/i.test(code(f)))
check('and the old face is not named anywhere', ghost.length === 0, ghost)

// Code has to be monospaced — a diff or a terminal in a proportional face is
// broken — so those call sites are expected. What must not appear is an inline
// family that is neither the mono variable nor a literal mono stack: that is a
// third face entering by the back door, which is how Georgia got in.
const inline = sources.flatMap((f) =>
  [...code(f).matchAll(/fontFamily:\s*("[^"]*"|'[^']*'|[^,\n]+)/g)].map((m) => ({
    file: f.replace(resolve('.'), ''),
    value: m[1].trim().replace(/,$/, ''),
  })),
)
const strays = inline.filter(
  (x) => !/--font-mono|monospace|Consolas|Cascadia|inherit/i.test(x.value),
)
check(
  'every inline fontFamily is monospace or inherited — no third face by the back door',
  strays.length === 0,
  strays,
)
console.log(`      ${inline.length} inline fontFamily uses, all accounted for`)

console.log(failures ? `\n${failures} FAILED` : '\ntwo faces, no strays')
process.exit(failures ? 1 : 0)
