/**
 * A rewind never writes one folder's files into another.
 *
 * The shadow store is keyed by CHAT, not by folder, and the two ends of
 * the feature disagreed about which folder they meant: snapshots were
 * taken in the run's own cwd (`getCwd()`), while the rewind and the diff
 * used the app's single global workspace. Switch the workspace between a
 * turn and a rewind and `reset --hard` did not fail — it wrote one
 * project's files over another's and deleted whatever the first did not
 * contain. Silently, and with no way back.
 *
 * Each store now records the folder its commits came from, and a rewind
 * that does not match refuses. This pins the comparison, which is the
 * part that has to be right on Windows: the same directory comes back
 * spelled several ways, and refusing over a spelling difference would be
 * its own bug.
 *
 *   npm run smoke:ckptfolder
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(
      `FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    )
  }
}

const { sameFolder } = await import('../src/main/agent/checkpoints.js')

// ─── The same folder, spelled differently ───────────────────────────────

{
  check('identical paths match', sameFolder('D:/work/app', 'D:/work/app'))
  check(
    'a trailing separator is not a different folder',
    sameFolder('D:/work/app', 'D:/work/app/'),
  )
  check(
    'backslashes and forward slashes are the same path on Windows',
    sameFolder('D:\\work\\app', 'D:/work/app'),
  )
  check(
    'case does not make it another folder on Windows',
    sameFolder('D:\\Work\\App', 'd:/work/app'),
  )
  check(
    'both spellings AND a trailing separator',
    sameFolder('D:\\Work\\App\\', 'd:/work/app'),
  )
}

// ─── Genuinely different folders ────────────────────────────────────────

{
  check(
    'two projects are not the same folder',
    !sameFolder('D:/work/app', 'D:/work/other'),
  )
  check(
    'a PARENT is not the same folder as its child',
    !sameFolder('D:/work', 'D:/work/app'),
  )
  check(
    'a sibling with a shared prefix is not the same folder',
    !sameFolder('D:/work/app', 'D:/work/app-2'),
  )
  check('nothing is not something', !sameFolder('', 'D:/work/app'))
}

console.log(
  failures ? `\n${failures} FAILED` : '\nA REWIND STAYS IN ITS OWN FOLDER',
)
process.exit(failures ? 1 : 0)
