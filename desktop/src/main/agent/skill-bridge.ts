/**
 * Getting a skill's files to where the model can reach them.
 *
 * A skill's "Base directory" is a HOST path. In Home the chat is isolated and
 * that path does not exist, so a skill whose SKILL.md says "read
 * SKILL-tearsheet.md" or "run scripts/foo.py" sends the model hunting: Read on
 * a host path (refused), then a bare relative path (absent), then find
 * (nothing), and it only recovers if it thinks to call the Skill tool.
 * Measured at five wasted steps on the equity-research skill. Both entry
 * points — the Skill tool and the slash-command expansion — bridge, so the
 * files are in place before the instructions are read.
 *
 * Split out of skill-tool.ts because none of this needs the command registry,
 * and the registry is a heavy thing to drag into a test: it reaches the
 * absorbed /init, which reaches a cloud SDK and a shell parser.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import { copyBufferIntoSandbox } from '../sandbox/files.js'

const SKILL_COPY_MAX_FILE = 2 * 1024 * 1024 // 2 MB per file
const SKILL_COPY_MAX_TOTAL = 12 * 1024 * 1024 // 12 MB total
const SKILL_COPY_MAX_COUNT = 200

/**
 * Where a skill's files land in the sandbox.
 *
 * They used to land in the ROOT, at the skill's own relative paths: a skill
 * with scripts/ and templates/ emptied both straight into the chat folder,
 * beside the user's own data. Two skills in one chat then interleaved, and a
 * shared filename simply overwrote — with nothing to say whose copy survived.
 * One folder per skill answers both.
 *
 * The suffix is for the case where two skills genuinely share a name — a user
 * skill and a plugin one, say. It comes from the skill's own directory rather
 * than from load order, so the same skill gets the same folder on every run
 * and a path written into an earlier message still resolves. Skills with
 * unique names — nearly all of them — keep the plain, readable folder.
 */
export function skillSandboxDir(
  name: string,
  skillDir: string,
  allNames: string[] = [],
): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|-+$/g, '') || 'skill'
  const twins = allNames.filter(n => n === name).length > 1
  if (!twins) return `skills/${slug}`
  let h = 0
  for (const ch of skillDir) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `skills/${slug}-${h.toString(36).slice(0, 6)}`
}

function copySkillFilesToSandbox(
  sessionId: string,
  skillDir: string,
  base: string,
): string[] {
  const copied: string[] = []
  let total = 0
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const e of entries) {
      if (copied.length >= SKILL_COPY_MAX_COUNT) return
      const full = join(dir, e)
      const rel = relative(skillDir, full).split(sep).join('/')
      if (rel === 'SKILL.md') continue // already inlined into the prompt
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (!st.isFile()) continue
      if (st.size === 0 || st.size > SKILL_COPY_MAX_FILE) continue
      if (total + st.size > SKILL_COPY_MAX_TOTAL) return
      try {
        if (copyBufferIntoSandbox(sessionId, `${base}/${rel}`, readFileSync(full))) {
          copied.push(`${base}/${rel}`)
          total += st.size
        }
      } catch {
        /* skip unreadable file */
      }
    }
  }
  walk(skillDir)
  return copied
}

/**
 * Copy a skill's bundled files into the chat sandbox and return the note that
 * tells the model where they are — or '' if there was nothing to bridge.
 */
export function bridgeSkillFilesToSandbox(
  sessionId: string,
  skillDir: string,
  name: string,
  allNames: string[] = [],
): string {
  const base = skillSandboxDir(name, skillDir, allNames)
  const copied = copySkillFilesToSandbox(sessionId, skillDir, base)
  if (copied.length === 0) return ''
  const shown = copied.slice(0, 20).join(', ')
  const more = copied.length > 20 ? ` (+${copied.length - 20} more)` : ''
  return (
    `\n\n---\n[Sandbox] This chat is isolated, so the skill's host "Base ` +
    `directory" above is NOT reachable — do not try to read it or find it on ` +
    `disk. The skill's files were copied into this chat's sandbox under ` +
    `${base}/, keeping their subfolders: wherever the instructions above name ` +
    `a bundled file, prefix it with ${base}/. Read them with Read or open them ` +
    `from RunPython (cwd is the sandbox root): ${shown}${more}. Some bundled ` +
    `scripts may rely on tools unavailable in the sandbox (e.g. LibreOffice); ` +
    `prefer generating output directly with RunPython.`
  )
}
