/**
 * The task_log SQL, run for real against a temporary database.
 *
 * task-log.ts wraps every statement in try/catch — a log must never break a
 * run — which means a malformed statement fails SILENTLY: no error, no rows,
 * and a Background tasks panel that is simply empty forever with nothing
 * anywhere saying why. Reading the SQL cannot rule that out; executing it can.
 *
 * The statements are lifted verbatim from src/main/task-log.ts. Importing the
 * module instead would drag in session-store and electron, which is why this
 * probe runs the SQL rather than the module — the check being made is that
 * SQLite accepts and honours these exact statements.
 *
 * Runs under Electron: better-sqlite3 is a native module built against
 * Electron's ABI, so plain `node` cannot load it (NODE_MODULE_VERSION 130 vs
 * 137). Same reason tray-probe and nativeimage-probe run there.
 */

const Database = require('better-sqlite3')

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const db = new Database(':memory:')

db.exec(`
  CREATE TABLE IF NOT EXISTS task_log (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    output TEXT
  );
  CREATE INDEX IF NOT EXISTS task_log_started ON task_log (started_at DESC);
`)
check('the schema is accepted', true)

const start = db.prepare(
  `INSERT OR IGNORE INTO task_log
     (id, session_id, tool, title, detail, status, started_at)
   VALUES (?, ?, ?, ?, ?, 'running', ?)`,
)
const finish = db.prepare(
  `UPDATE task_log SET status = ?, finished_at = ?, output = ?
   WHERE id = ? AND status = 'running'`,
)
const settle = db.prepare(
  `UPDATE task_log SET status = 'error', finished_at = ?
   WHERE session_id = ? AND status = 'running'`,
)
const orphans = db.prepare(
  `UPDATE task_log SET status = 'error', finished_at = COALESCE(finished_at, ?)
   WHERE status = 'running'`,
)
const list = db.prepare(`SELECT * FROM task_log ORDER BY started_at DESC LIMIT ?`)
const clearFinished = db.prepare(`DELETE FROM task_log WHERE status != 'running'`)
const prune = db.prepare(
  `DELETE FROM task_log WHERE status != 'running' AND id NOT IN (
     SELECT id FROM task_log ORDER BY started_at DESC LIMIT ?
   )`,
)
const row = (id) => db.prepare('SELECT * FROM task_log WHERE id = ?').get(id)

// -- insert + close ---------------------------------------------------
start.run('t1', 's1', 'Bash', 'List files', 'ls -la', 1000)
check('a call is recorded', row('t1')?.status === 'running', row('t1')?.status)
check('with its detail', row('t1')?.detail === 'ls -la')

finish.run('done', 2000, 'a.txt', 't1')
check('its result closes the row', row('t1')?.status === 'done')
check('and stores the output', row('t1')?.output === 'a.txt')
check('with an end time', row('t1')?.finished_at === 2000)

// A repeated call event must not open a second row, nor reset the first.
start.run('t1', 's1', 'Bash', 'DIFFERENT', 'rm -rf', 9999)
check('a duplicate call is ignored', row('t1')?.title === 'List files', row('t1')?.title)
check('and does not reopen it', row('t1')?.status === 'done')

// A late duplicate result must not overwrite the real one.
finish.run('error', 3000, 'nope', 't1')
check('a late duplicate result is refused', row('t1')?.output === 'a.txt')

// -- settling a session ------------------------------------------------
start.run('t2', 's1', 'Bash', 'interrupted', null, 1100)
start.run('t3', 's2', 'Bash', 'other chat', null, 1200)
settle.run(4000, 's1')
check('a stopped run settles its open rows', row('t2')?.status === 'error')
check('and does not touch another session', row('t3')?.status === 'running')
// The subtle one: settling must not relabel rows that already finished.
check('a finished row keeps its result', row('t1')?.status === 'done')

// -- orphans from a killed process -------------------------------------
orphans.run(5000)
check('startup settles rows left running', row('t3')?.status === 'error')
check('and stamps an end time', row('t3')?.finished_at === 5000)

// -- ordering ----------------------------------------------------------
{
  const rows = list.all(10)
  const times = rows.map((r) => r.started_at)
  check(
    'listing is newest first',
    times.every((v, i) => i === 0 || times[i - 1] >= v),
    JSON.stringify(times),
  )
}

// -- prune keeps the newest, never a running row -----------------------
{
  db.exec('DELETE FROM task_log')
  for (let i = 0; i < 20; i++) {
    start.run(`p${i}`, 's1', 'Bash', `run ${i}`, null, 1000 + i)
    finish.run('done', 2000, 'ok', `p${i}`)
  }
  start.run('live', 's1', 'Bash', 'still going', null, 500) // oldest of all
  prune.run(5)
  const kept = db.prepare('SELECT id FROM task_log').all().map((r) => r.id)
  check('prune trims to the cap', kept.filter((id) => id.startsWith('p')).length <= 5, kept.length)
  check('keeping the newest', kept.includes('p19'), JSON.stringify(kept))
  check('dropping the oldest finished', !kept.includes('p0'))
  // A running row is the oldest here on purpose: trimming it would strand it
  // as permanently unfinished, with its result arriving to nothing.
  check('but never the running one', kept.includes('live'))
}

// -- Clear ------------------------------------------------------------
{
  clearFinished.run()
  const left = db.prepare('SELECT id, status FROM task_log').all()
  check('Clear removes finished rows', left.every((r) => r.status === 'running'))
  check('and keeps the running one', left.some((r) => r.id === 'live'), JSON.stringify(left))
}

console.log(failures ? `\n${failures} FAILED` : '\nALL TASK-LOG SQL CHECKS PASSED')
process.exit(failures ? 1 : 0)
