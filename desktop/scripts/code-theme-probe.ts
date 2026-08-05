/**
 * Code themes: the palette data is complete, and applying one writes the
 * exact variables globals.css reads.
 *
 * The risk in a data file is a silent hole: one palette missing one slot
 * paints that token kind with whatever mode the OTHER theme left behind —
 * a light-grey comment on a light panel, invisible. So every palette is
 * checked for every slot, every value for being a real colour, and the
 * defaults for reproducing the pre-themes palette verbatim.
 *
 *   npm run smoke:codetheme
 */

// Minimal DOM/storage so the apply path runs under plain Node.
const styleEl = { id: "", textContent: "" };
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
};
(globalThis as Record<string, unknown>).document = {
  getElementById: () => null,
  createElement: () => styleEl,
  head: { appendChild: () => {} },
};
(globalThis as Record<string, unknown>).window = { dispatchEvent: () => {} };
(globalThis as Record<string, unknown>).Event = class {};

const {
  CODE_THEMES,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  applyCodeThemes,
  currentThemeId,
  themesFor,
} = await import('../src/renderer/lib/code-theme.js')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

const SLOTS = [
  'comment', 'punct', 'const', 'class', 'keyword',
  'tag', 'string', 'func', 'var', 'op',
] as const

check('a real spread of themes, both modes', CODE_THEMES.length >= 20, CODE_THEMES.length)
check('at least 8 light', themesFor('light').length >= 8, themesFor('light').length)
check('at least 8 dark', themesFor('dark').length >= 8, themesFor('dark').length)
check(
  'ids are unique',
  new Set(CODE_THEMES.map((t) => t.id)).size === CODE_THEMES.length,
)
for (const t of CODE_THEMES) {
  const missing = SLOTS.filter((s) => !t.colors[s])
  const bad = SLOTS.filter((s) => t.colors[s] && !/^#[0-9a-f]{6}$/i.test(t.colors[s]))
  if (missing.length || bad.length)
    check(`palette ${t.id} is complete and hex`, false, { missing, bad })
}
check('every palette carries every slot as 6-digit hex', failures === 0)

check('the light default exists and is light',
  CODE_THEMES.some((t) => t.id === DEFAULT_LIGHT && t.mode === 'light'))
check('the dark default exists and is dark',
  CODE_THEMES.some((t) => t.id === DEFAULT_DARK && t.mode === 'dark'))
check('nothing stored → the defaults', currentThemeId('light') === DEFAULT_LIGHT && currentThemeId('dark') === DEFAULT_DARK)

// The defaults must reproduce the pre-themes globals.css palette verbatim —
// an app updated across this change must not look different.
const oneLight = CODE_THEMES.find((t) => t.id === DEFAULT_LIGHT)!
const vsDark = CODE_THEMES.find((t) => t.id === DEFAULT_DARK)!
check(
  'default light IS the original palette',
  oneLight.colors.comment === '#a0a1a7' &&
    oneLight.colors.keyword === '#a626a4' &&
    oneLight.colors.string === '#50a14f' &&
    oneLight.colors.func === '#4078f2' &&
    oneLight.colors.var === '#4078f2' && // the original merged var with func
    oneLight.colors.class === '#b76b01', // …and class-name with constants
  oneLight.colors,
)
check(
  'default dark IS the original palette',
  vsDark.colors.comment === '#6a9955' &&
    vsDark.colors.class === '#4ec9b0' &&
    vsDark.colors.func === '#dcdcaa' &&
    vsDark.colors.var === '#9cdcfe',
  vsDark.colors,
)

// ─── Applying writes what globals.css reads ─────────────────────────────

applyCodeThemes()
const css = styleEl.textContent
check('one :root block and one .dark block', /:root \{/.test(css) && /\.dark \{/.test(css), css.slice(0, 80))
check(
  'every slot lands as a --code-* variable, twice',
  SLOTS.every((s) => (css.match(new RegExp(`--code-${s}:`, 'g')) ?? []).length === 2),
  css,
)
check(
  'the light values sit in :root, the dark in .dark',
  css.indexOf('#a0a1a7') < css.indexOf('.dark') &&
    css.indexOf('#6a9955') > css.indexOf('.dark'),
)

console.log(failures === 0 ? '\nALL CODE-THEME CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
