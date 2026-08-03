/**
 * The map of what the model can still read.
 *
 * A boundary off by one turn tells the user a lie about what the model
 * knows — a worse lie than the silence it replaces, because it looks
 * authoritative. So the arithmetic gets pinned down here: compactions cut
 * from the FRONT, undo cuts from the BACK, and the two renumber the context
 * against a transcript that never renumbers itself.
 *
 *   npm run smoke:ctxmap
 */

import {
  buildContextMap,
  describeRange,
  outOfContextRanges,
  turnOrdinals,
  type ContextEventInfo,
} from '../src/renderer/lib/context-map.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

const ev = (o: Partial<ContextEventInfo>): ContextEventInfo => ({
  id: o.id ?? 'e1',
  type: o.type ?? 'compact',
  at: o.at ?? '2026-08-03T10:00:00.000Z',
  ...o,
})

/** A transcript of N turns: user, assistant, tool, per turn. */
const roles = (turns: number): string[] =>
  Array.from({ length: turns }, () => ['user', 'assistant', 'tool']).flat()

// ─── Turn ordinals ──────────────────────────────────────────────────────

check(
  'every message belongs to the prompt above it',
  JSON.stringify(turnOrdinals(['user', 'assistant', 'user', 'tool'])) ===
    JSON.stringify([0, 0, 1, 1]),
)
check(
  'anything before the first prompt belongs to no turn',
  turnOrdinals(['assistant', 'user'])[0] === -1,
)

// ─── Compaction cuts the front ──────────────────────────────────────────

{
  // 10 turns on screen; a compaction folded the first 6 into a summary.
  const ranges = outOfContextRanges([
    ev({ type: 'compact', userTurnsBefore: 10, userTurnsAfter: 4, headOffset: 0, beforeTokens: 42000, afterTokens: 12000 }),
  ])
  check('one range', ranges.length === 1, ranges)
  check('covering the FRONT', ranges[0]!.from === 0 && ranges[0]!.to === 6, ranges[0])
  const map = buildContextMap(roles(10), ranges)
  check('18 messages dimmed (6 turns × 3)', map.out.size === 18, map.out.size)
  check('the last in-context turn is untouched', !map.out.has(27))
  check('4 turns remain', map.inContextTurns === 4, map.inContextTurns)
  check(
    'the marker sits at the first message the model still reads',
    map.markers.has(18) && map.markers.get(18)![0]!.kind === 'compacted',
    [...map.markers.keys()],
  )
  check('and nothing trails', map.trailing.length === 0)
  check(
    'it says what it did, with the tokens',
    /Auto-compacted/.test(describeRange(ranges[0]!)) &&
      describeRange(ranges[0]!).includes('42.0k'),
    describeRange(ranges[0]!),
  )
}

// ─── Undo cuts the back ─────────────────────────────────────────────────

{
  // 5 turns, the last one undone.
  const ranges = outOfContextRanges([
    ev({ id: 'u1', type: 'rewind', userTurnsBefore: 5, userTurnsAfter: 4, headOffset: 0 }),
  ])
  check('covering the TAIL', ranges[0]!.from === 4 && ranges[0]!.to === 5, ranges[0])
  const map = buildContextMap(roles(5), ranges)
  check('the last turn is dimmed', map.out.has(12) && map.out.has(14))
  check('the ones before it are not', !map.out.has(11))
  check(
    'with nothing after it, the marker trails the transcript',
    map.trailing.length === 1 && map.markers.size === 0,
  )
  check('the wording counts prompts', describeRange(ranges[0]!).includes('1 prompt'))
}

{
  // Undone, then the conversation continued: the gap is in the MIDDLE.
  const ranges = outOfContextRanges([
    ev({ id: 'u1', type: 'rewind', userTurnsBefore: 5, userTurnsAfter: 4, headOffset: 0 }),
  ])
  const map = buildContextMap(roles(7), ranges)
  check('only turn 4 is out', map.out.has(12) && !map.out.has(15) && !map.out.has(9))
  check(
    'and the marker lands where the context resumes',
    map.markers.has(15),
    [...map.markers.keys()],
  )
  check('six turns still readable', map.inContextTurns === 6, map.inContextTurns)
}

// ─── Both, in the same chat ─────────────────────────────────────────────

{
  // A compaction dropped 6, then an undo removed the last of what remained.
  // The undo's counts are CONTEXT-relative: headOffset translates them.
  const ranges = outOfContextRanges([
    ev({ id: 'c1', type: 'compact', userTurnsBefore: 10, userTurnsAfter: 4, headOffset: 0 }),
    ev({ id: 'u1', type: 'rewind', userTurnsBefore: 5, userTurnsAfter: 4, headOffset: 6 }),
  ])
  check('two ranges', ranges.length === 2, ranges)
  check('the compaction still covers 0–6', ranges[0]!.from === 0 && ranges[0]!.to === 6)
  check(
    'and the undo lands at absolute 10, not 4',
    ranges[1]!.from === 10 && ranges[1]!.to === 11,
    ranges[1],
  )
  const map = buildContextMap(roles(12), ranges)
  check('turn 10 is out, turn 9 is in', map.out.has(30) && !map.out.has(27))
  check(
    'both markers are placed',
    map.markers.size === 2 && map.markers.has(18) && map.markers.has(33),
    [...map.markers.keys()],
  )
  check('five turns readable', map.inContextTurns === 5, map.inContextTurns)
}

// ─── Refusing to guess ──────────────────────────────────────────────────

{
  check(
    'an event with no turn counts is skipped, not guessed at',
    outOfContextRanges([ev({ type: 'compact', beforeTokens: 100, afterTokens: 10 })]).length === 0,
  )
  check(
    'and so is one that removed nothing',
    outOfContextRanges([ev({ userTurnsBefore: 4, userTurnsAfter: 4 })]).length === 0,
  )
  const ranges = outOfContextRanges([
    ev({ type: 'compact', userTurnsBefore: 10, userTurnsAfter: 4, headOffset: 0 }),
  ])
  const short = buildContextMap(roles(2), ranges)
  check(
    'a range past the end of a trimmed transcript marks what it can',
    short.out.size === 6 && short.trailing.length === 1,
    { out: short.out.size, trailing: short.trailing.length },
  )
  check(
    'an empty chat maps to nothing',
    buildContextMap([], ranges).out.size === 0,
  )
}

console.log(
  failures === 0 ? '\nALL CONTEXT-MAP CHECKS PASSED' : `\n${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
