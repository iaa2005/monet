/**
 * The diff pipeline: what counts as a row, and where the dividers go.
 *
 * The regression this pins down shipped once: SandboxEdit wraps its patch in
 * prose and a markdown fence, and the parser numbered "Edited foo.html
 * (38.3 KB)." as context line 1 of the diff — while the jump between two
 * hunks (377 → 518) rendered with no divider at all, as if the file had
 * lost a hundred lines.
 *
 *   npm run smoke:diff
 */

import {
  computeRows,
  foldRows,
  parseUnifiedDiff,
  isUnifiedDiff,
} from '../src/renderer/components/chat/diff-core.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── A tool result: prose + fence around a two-hunk patch ───────────────

const wrapped = [
  'Edited little-coder-clone.html (38.3 KB).',
  '',
  '```diff',
  '--- little-coder-clone.html',
  '+++ little-coder-clone.html',
  '@@ -370,3 +370,3 @@',
  ' background: var(--ink-08);',
  '-.bench-bar { background: rgba(242,235,220,0.12); }',
  '+.bench-bar { background: rgba(255,255,255,0.12); }',
  '@@ -518,2 +518,2 @@',
  ' display: flex;',
  '-  align-items: centre;',
  '+  align-items: center;',
  '```',
].join('\n')

check('the wrapped patch is still detected as a diff', isUnifiedDiff(wrapped))

const rows = parseUnifiedDiff(wrapped)
check(
  'prose before the first hunk is not a row',
  rows.every((r) => !r.text.includes('38.3 KB')),
  rows[0],
)
check(
  'fences are not rows either',
  rows.every((r) => !r.text.startsWith('```')),
)
check(
  'the first row is numbered by the hunk header, not from 1',
  rows[0]?.oldNo === 370 && rows[0]?.newNo === 370,
  rows[0],
)
check(
  'both hunks came through',
  rows.some((r) => r.oldNo === 518),
  rows.map((r) => r.oldNo),
)
check(
  'kinds survive: one removed, one added per hunk',
  rows.filter((r) => r.kind === 'removed').length === 2 &&
    rows.filter((r) => r.kind === 'added').length === 2,
)

// ─── The hunk boundary becomes an explicit, non-expandable gap ──────────

{
  const segs = foldRows(rows)
  const hunkGaps = segs.filter((s) => s.kind === 'gap' && s.rows.length === 0)
  check('the jump between hunks is a divider, not a silent cut', hunkGaps.length === 1, segs)
  check(
    'and it knows how many lines it stands for',
    hunkGaps[0]?.kind === 'gap' && hunkGaps[0].skipped === 146,
    hunkGaps[0],
  )
}

// ─── An ordinary two-text diff must not grow spurious dividers ──────────

{
  const oldT = [...Array(30).keys()].map((i) => `line ${i}`).join('\n')
  const newT = oldT.replace('line 15', 'line fifteen')
  const segs = foldRows(computeRows(oldT, newT))
  check(
    'a contiguous diff has no hunk dividers',
    segs.every((s) => !(s.kind === 'gap' && s.rows.length === 0)),
    segs.map((s) => ({ kind: s.kind, n: s.rows.length })),
  )
  const gap = segs.find((s) => s.kind === 'gap')
  check('long unchanged runs still fold', !!gap && gap.rows.length > 2)
}

// ─── A clean patch (no prose) parses exactly as before ──────────────────

{
  const clean = ['@@ -5,3 +5,3 @@', ' a', '-b', '+B', ' c'].join('\n')
  const r = parseUnifiedDiff(clean)
  check(
    'a bare patch needs no wrapping to parse',
    r.length === 4 && r[0]?.oldNo === 5 && r[1]?.kind === 'removed',
    r,
  )
}

console.log(failures === 0 ? '\nALL DIFF-CORE CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
