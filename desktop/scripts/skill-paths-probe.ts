/**
 * A skill's files land in a folder of their own.
 *
 * They used to land in the chat's ROOT, at whatever relative paths the skill
 * happened to use: a skill with scripts/ and templates/ emptied both into the
 * sandbox beside the user's own data, two skills in one chat interleaved, and
 * a shared filename — README.md, config.json, utils.py — simply overwrote,
 * with nothing on either side to say whose copy won.
 *
 * So this drives the real copy into a real sandbox and looks at where the
 * bytes end up.
 *
 *   npm run smoke:skillpaths
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  bridgeSkillFilesToSandbox,
  skillSandboxDir,
} from '../src/main/agent/skill-bridge.js'
import { sandboxWorkDir } from '../src/main/sandbox/podman-engine.js'
import { listSandboxFiles } from '../src/main/sandbox/files.js'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
  )
}

// ─── Naming ─────────────────────────────────────────────────────────────

check(
  'a skill gets a folder under skills/',
  skillSandboxDir('pdf', '/home/u/.claude/skills/pdf') === 'skills/pdf',
  skillSandboxDir('pdf', '/home/u/.claude/skills/pdf'),
)
check(
  'a name with spaces and capitals is still a usable folder',
  skillSandboxDir('Equity Research', '/a/b') === 'skills/equity-research',
  skillSandboxDir('Equity Research', '/a/b'),
)
check(
  'a name made entirely of punctuation still produces a folder',
  /^skills\/[a-z0-9._-]+$/.test(skillSandboxDir('!!!', '/a/b')),
  skillSandboxDir('!!!', '/a/b'),
)
check(
  'no traversal can come out of a skill name',
  !skillSandboxDir('../../etc', '/a/b').includes('..'),
  skillSandboxDir('../../etc', '/a/b'),
)

// Two skills, one name, different sources — the case the user named. They
// must not share a folder, and each must keep the SAME folder across runs,
// because a path already written into an earlier message has to keep working.
{
  const names = ['pdf', 'pdf', 'chart']
  const a = skillSandboxDir('pdf', '/home/u/.claude/skills/pdf', names)
  const b = skillSandboxDir('pdf', '/opt/plugins/office/skills/pdf', names)
  check('two skills of one name do not share a folder', a !== b, [a, b])
  check(
    'both still live under skills/, readably',
    a.startsWith('skills/pdf') && b.startsWith('skills/pdf'),
    [a, b],
  )
  check(
    'the folder comes from the source, not from load order',
    skillSandboxDir('pdf', '/opt/plugins/office/skills/pdf', names) === b &&
      skillSandboxDir('pdf', '/opt/plugins/office/skills/pdf', [...names].reverse()) === b,
  )
  check(
    'a unique name is not punished with a suffix',
    skillSandboxDir('chart', '/x/chart', names) === 'skills/chart',
  )
}

// ─── The copy itself ────────────────────────────────────────────────────

const sid = 'probe-skill-paths'
const root = sandboxWorkDir(sid)
const src = join(root, '__source__')
rmSync(root, { recursive: true, force: true })
mkdirSync(join(src, 'one', 'scripts'), { recursive: true })
mkdirSync(join(src, 'two', 'scripts'), { recursive: true })

// Two skills that share filenames at the same relative paths — the collision.
for (const [dir, mark] of [
  ['one', 'FIRST'],
  ['two', 'SECOND'],
] as const) {
  writeFileSync(join(src, dir, 'SKILL.md'), `# ${mark}`, 'utf8')
  writeFileSync(join(src, dir, 'README.md'), mark, 'utf8')
  writeFileSync(join(src, dir, 'scripts', 'run.py'), `print("${mark}")`, 'utf8')
}
// The user's own file, in the root where the skills used to land.
writeFileSync(join(root, 'data.csv'), 'a,b\n1,2\n', 'utf8')

const noteA = bridgeSkillFilesToSandbox(sid, join(src, 'one'), 'alpha')
const noteB = bridgeSkillFilesToSandbox(sid, join(src, 'two'), 'beta')

check(
  "alpha's files are under its own folder",
  existsSync(join(root, 'skills', 'alpha', 'README.md')) &&
    existsSync(join(root, 'skills', 'alpha', 'scripts', 'run.py')),
)
check(
  "…and beta's under its own",
  existsSync(join(root, 'skills', 'beta', 'README.md')) &&
    existsSync(join(root, 'skills', 'beta', 'scripts', 'run.py')),
)
check(
  'neither overwrote the other',
  readFileSync(join(root, 'skills', 'alpha', 'README.md'), 'utf8') === 'FIRST' &&
    readFileSync(join(root, 'skills', 'beta', 'README.md'), 'utf8') === 'SECOND',
)
check(
  'the chat root is not littered with either',
  !existsSync(join(root, 'README.md')) && !existsSync(join(root, 'scripts')),
)
check(
  "the user's own file is untouched",
  readFileSync(join(root, 'data.csv'), 'utf8') === 'a,b\n1,2\n',
)
check(
  'SKILL.md is not copied — it is already in the prompt',
  !existsSync(join(root, 'skills', 'alpha', 'SKILL.md')),
)

// The note is what tells the model where to look; a path in it that is not
// the path on disk is worse than no note at all.
check('the note names the folder', noteA.includes('skills/alpha/'), noteA.slice(0, 120))
// Filenames only — the sentence "prefix it with skills/alpha/." puts a full
// stop right against the path, and a greedier pattern reads that as part of
// the name. Which the model could do too, so the listing goes LAST in the
// note with nothing after it.
{
  const listed = noteA.match(/skills\/alpha\/[\w/-]+\.\w+/g) ?? []
  check(
    '…and every file it lists is really there',
    listed.length > 0 && listed.every(p => existsSync(join(root, ...p.split('/')))),
    listed,
  )
}
check('the two notes do not describe the same folder', !noteB.includes('skills/alpha/'))
check(
  'a skill with no bundled files says nothing at all',
  bridgeSkillFilesToSandbox(sid, join(src, 'nonexistent'), 'ghost') === '',
)

// The listing the model and the Files panel see.
{
  const listed = listSandboxFiles(sid).map(f => f.name)
  check(
    'the copied files are visible to Read/Glob',
    listed.includes('skills/alpha/scripts/run.py'),
    listed.filter(n => n.startsWith('skills/')),
  )
}

rmSync(root, { recursive: true, force: true })

console.log(
  failures ? `\n${failures} FAILURES` : '\nEVERY SKILL KEEPS ITS OWN FOLDER',
)
process.exit(failures ? 1 : 0)
