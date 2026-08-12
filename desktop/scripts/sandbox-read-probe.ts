/**
 * The chart's `src` reads a real file out of a real sandbox.
 *
 * It did not, and the failure was invisible until a chart said "outside
 * artifacts dir": the renderer was reading through artifacts:readText, which
 * resolves under the ARTIFACTS directory, and a sandbox file is not there.
 * Two containment guards, two roots, and the widget was pointed at the wrong
 * one. This drives the sandbox reader the IPC now calls.
 */

import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { readSandboxFile } from '../src/main/sandbox/files.js'
import { sandboxWorkDir } from '../src/main/sandbox/podman-engine.js'

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const sid = 'probe-chart-src'
const root = sandboxWorkDir(sid)
mkdirSync(join(root, 'out'), { recursive: true })

const rows = {
  labels: ['2026-07-13', '2026-07-14'],
  ohlc: [
    [404.61, 405.57, 391.37, 394.76],
    [399.05, 402.22, 394.76, 396.18],
  ],
  volume: [58200000, 41300000],
}
writeFileSync(join(root, 'tsla.json'), JSON.stringify(rows), 'utf8')
writeFileSync(join(root, 'out', 'nested.json'), JSON.stringify(rows), 'utf8')

const top = readSandboxFile(sid, 'tsla.json')
check('a file at the sandbox root reads', top.ok && !!top.content)
check(
  'and parses back to the rows the chart wants',
  (() => {
    try {
      const d = JSON.parse(top.content ?? '') as typeof rows
      return d.ohlc.length === 2 && d.labels[0] === '2026-07-13'
    } catch {
      return false
    }
  })(),
)

const nested = readSandboxFile(sid, 'out/nested.json')
check('a file in a subfolder reads by its relative path', nested.ok)

// Containment. These are the shapes an escape would take, and each must fail
// as a path — not merely be absent.
check('a missing name fails', !readSandboxFile(sid, 'nope.json').ok)
check(
  'traversal is refused',
  !readSandboxFile(sid, '../../../package.json').ok,
  readSandboxFile(sid, '../../../package.json').error,
)
check(
  'an absolute path is refused',
  !readSandboxFile(sid, join(process.cwd(), 'package.json')).ok,
)
check('an empty name is refused', !readSandboxFile(sid, '').ok)

// Another chat's sandbox is another directory: the same name must not reach it.
const other = 'probe-chart-src-other'
mkdirSync(sandboxWorkDir(other), { recursive: true })
writeFileSync(join(sandboxWorkDir(other), 'secret.json'), '{"a":1}', 'utf8')
check(
  "one chat cannot read another chat's file",
  !readSandboxFile(sid, 'secret.json').ok,
)

rmSync(root, { recursive: true, force: true })
rmSync(sandboxWorkDir(other), { recursive: true, force: true })

console.log(failures === 0 ? '\nSRC READS THE SANDBOX, AND ONLY THIS CHAT’S' : `\n${failures} FAILURES`)
process.exit(failures ? 1 : 0)
