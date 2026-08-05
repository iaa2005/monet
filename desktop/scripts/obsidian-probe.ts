/**
 * The Obsidian subsystem, up to the tool boundary.
 *
 * Pins the three layers the tools stand on: parsing (wikilinks, frontmatter,
 * tags — hand-typed YAML, so leniency is the spec), the index (incremental
 * by mtime, name/alias resolution incl. the ambiguity contract, search
 * scoring, backlinks), and the registry (add/toggle/remove, read-only).
 * Runs against a real temp vault on disk — the walk, the skip rules and the
 * mtime cache are exactly the things a pure mock would fake away.
 *
 *   npm run smoke:obsidian
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir } from '../src/main/data-dir.js'

const tempData = mkdtempSync(join(tmpdir(), 'obsidian-probe-data-'))
setDataDir(tempData)

const {
  parseWikilinks,
  parseBodyTags,
  parseFrontmatterList,
  parseNote,
  splitNote,
  composeNote,
  noteNameOf,
} = await import('../src/main/obsidian/notes.js')
const { addVault, updateVault, removeVault, listVaults, enabledVaults, hasEnabledVaults } =
  await import('../src/main/obsidian/vaults.js')
const { allNotes, resolveNote, searchNotes, backlinksTo, vaultStats } =
  await import('../src/main/obsidian/index.js')
const { buildVaultPrompt } = await import('../src/main/obsidian/prompt.js')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── Parsing ────────────────────────────────────────────────────────────

check(
  'wikilinks: plain, aliased, heading — one name each',
  JSON.stringify(parseWikilinks('см [[Alpha]] и [[Beta|бету]] и [[Gamma#intro]]')) ===
    JSON.stringify(['Alpha', 'Beta', 'Gamma']),
  parseWikilinks('см [[Alpha]] и [[Beta|бету]] и [[Gamma#intro]]'),
)
check('embeds are attachments, not links', parseWikilinks('![[img.png]] и [[Note]]').length === 1)
check(
  'tags: body tags found, headings and issue numbers are not tags',
  JSON.stringify(parseBodyTags('# Title\nтекст #проект/ml и #Idea\nfix #42')) ===
    JSON.stringify(['проект/ml', 'idea']),
  parseBodyTags('# Title\nтекст #проект/ml и #Idea\nfix #42'),
)
check(
  'tags inside code fences are ignored',
  parseBodyTags('```\n#not-a-tag\n```\n#real').join() === 'real',
)
check(
  'frontmatter list: inline and block forms',
  JSON.stringify(parseFrontmatterList('tags: [a, b]', 'tags')) === JSON.stringify(['a', 'b']) &&
    JSON.stringify(parseFrontmatterList('aliases:\n  - Один\n  - Two', 'aliases')) ===
      JSON.stringify(['Один', 'Two']),
)
check(
  'splitNote: frontmatter off, body intact; --- later in body is not frontmatter',
  splitNote('---\ntags: [x]\n---\nBody').body === 'Body' &&
    splitNote('Body\n---\nmore').frontmatter === '',
)
check('noteNameOf drops folders and .md', noteNameOf('proj/Deep Note.md') === 'Deep Note')
{
  const composed = composeNote({ body: 'Text', tags: ['a'], aliases: ['B'] })
  check(
    'composeNote emits valid frontmatter + body',
    composed.startsWith('---\ntags: [a]\naliases: [B]\n---\n\nText'),
    composed,
  )
  const meta = parseNote('X.md', composed)
  check('…which parses back to the same tags/aliases', meta.tags.join() === 'a' && meta.aliases.join() === 'B')
}

// ─── A real vault on disk ───────────────────────────────────────────────

const vaultDir = mkdtempSync(join(tmpdir(), 'obsidian-probe-vault-'))
mkdirSync(join(vaultDir, '.obsidian'), { recursive: true })
mkdirSync(join(vaultDir, 'projects'), { recursive: true })
mkdirSync(join(vaultDir, '.trash'), { recursive: true })
writeFileSync(
  join(vaultDir, 'Attention.md'),
  '---\ntags: [paper, ml]\naliases: [Attention Is All You Need]\n---\nTransformers: см [[Self-Attention]] и [[Scaling Laws]].\n',
)
writeFileSync(join(vaultDir, 'Self-Attention.md'), 'Механизм внимания. #ml\n')
writeFileSync(join(vaultDir, 'projects', 'Scaling Laws.md'), 'Chinchilla. Ссылка на [[Attention]].\n')
// A name collision in another folder — the ambiguity case.
writeFileSync(join(vaultDir, 'projects', 'Self-Attention.md'), 'Дубликат имени в папке projects.\n')
// Trash must be invisible.
writeFileSync(join(vaultDir, '.trash', 'Deleted.md'), 'мусор\n')

const added = addVault(vaultDir, 'TestVault')
check('a folder registers as a vault', added.ok === true, added)
check('double-add is refused', addVault(vaultDir).ok === false)
check('the registry lists it enabled', enabledVaults().length === 1 && hasEnabledVaults())

const notes = allNotes()
check('the walk finds all notes and skips .trash/.obsidian', notes.length === 4, notes.map((n) => n.relPath))

// ─── Resolution ─────────────────────────────────────────────────────────

{
  const one = resolveNote('attention', notes)
  check('a name resolves case-insensitively', one.kind === 'one' && one.kind === 'one' && one.note.name === 'Attention')
  const viaAlias = resolveNote('Attention Is All You Need', notes)
  check('an alias resolves too', viaAlias.kind === 'one')
  const many = resolveNote('Self-Attention', notes)
  check('a duplicated name reports ambiguity, never picks silently', many.kind === 'many')
  const byPath = resolveNote('projects/Self-Attention.md', notes)
  check('an explicit path settles the ambiguity', byPath.kind === 'one')
  check('a missing note is "none"', resolveNote('Nope', notes).kind === 'none')
}

// ─── Search and graph ───────────────────────────────────────────────────

{
  const byName = searchNotes('attention', notes)
  check('name match outranks body match', byName[0]?.note.name === 'Attention', byName.map((h) => h.note.name))
  const byTag = searchNotes('tag:paper', notes)
  check('tag: filter works alone', byTag.length === 1 && byTag[0].note.name === 'Attention')
  const byLink = searchNotes('link:Attention', notes)
  check('link: finds notes pointing AT a note', byLink.length === 1 && byLink[0].note.relPath === 'projects/Scaling Laws.md')
  const text = searchNotes('chinchilla', notes)
  check('full text matches with a snippet', text.length === 1 && text[0].snippet.includes('Chinchilla'))
  check('an unmatched word means no hit', searchNotes('квантовая-гравитация', notes).length === 0)
  const back = backlinksTo('Attention', notes)
  check('backlinks come from wikilinks', back.length === 1 && back[0].name === 'Scaling Laws')
}

// ─── Incremental refresh ────────────────────────────────────────────────

{
  writeFileSync(join(vaultDir, 'Self-Attention.md'), 'Обновлено: см [[Attention]]. #ml\n')
  // A fresh mtime, even on filesystems with coarse timestamps.
  const future = new Date(Date.now() + 5000)
  utimesSync(join(vaultDir, 'Self-Attention.md'), future, future)
  const fresh = allNotes()
  const updated = fresh.find((n) => n.relPath === 'Self-Attention.md')
  check('an edited note is re-read on the next call', updated?.links.join() === 'Attention', updated?.links)
  check('and the vault stats see the whole picture', vaultStats(listVaults()[0]).notes === 4)
}

// ─── The directive ──────────────────────────────────────────────────────

{
  const p = buildVaultPrompt()
  check('the directive names the vault and its size', !!p && p.includes('"TestVault"') && p.includes('4 notes'), p?.slice(0, 120))
  check('and carries the protocol', !!p && /SEARCH FIRST/.test(p) && /WRITE ONLY ON REQUEST/.test(p))
}

// ─── Canvas and Bases join the graph ────────────────────────────────────

{
  const { parseCanvas, canvasToMarkdown } = await import('../src/shared/obsidian-canvas.js')
  const canvas = JSON.stringify({
    nodes: [
      { id: '1', type: 'text', text: 'Идея: связать [[Attention]] с масштабированием' },
      { id: '2', type: 'file', file: 'projects/Scaling Laws.md' },
      { id: '3', type: 'file', file: 'img/plot.png' },
      { id: '4', type: 'group', label: 'Research' },
      { id: '5', type: 'link', url: 'https://arxiv.org/abs/1706.03762' },
    ],
    edges: [{ id: 'e1', fromNode: '1', toNode: '2' }],
  })
  const parsed = parseCanvas(canvas)!
  check(
    'canvas: cards, note refs, files, groups and urls all land',
    parsed.texts.length === 1 && parsed.noteRefs.join() === 'Scaling Laws' &&
      parsed.fileRefs.join() === 'img/plot.png' && parsed.groups.join() === 'Research' &&
      parsed.urls.length === 1 && parsed.edgeCount === 1,
    parsed,
  )
  const md = canvasToMarkdown('Board', canvas)
  check(
    'canvas renders as readable markdown with wikilinks',
    md.includes('[[Scaling Laws]]') && md.includes('> Идея') && md.includes('5 node(s)'),
    md.slice(0, 120),
  )
  check('a broken canvas degrades, not throws', canvasToMarkdown('X', '{oops').includes('unreadable'))

  writeFileSync(join(vaultDir, 'Board.canvas'), canvas)
  const withCanvas = allNotes()
  const board = withCanvas.find((n) => n.name === 'Board')
  check('the canvas is indexed under its bare name', board?.format === 'canvas', board?.format)
  check(
    'its cards and file nodes become vault links',
    board?.links.includes('Attention') === true && board?.links.includes('Scaling Laws') === true,
    board?.links,
  )
  check(
    'a canvas card is searchable full-text',
    searchNotes('масштабированием', withCanvas).some((h) => h.note.name === 'Board'),
  )
  check(
    'the canvas backlinks into the graph',
    backlinksTo('Attention', withCanvas).some((n) => n.name === 'Board'),
  )

  // Structured formats take no text edits — only read and trash.
  const { VaultWriteTool } = await import('../src/main/obsidian/tools.js')
  const refused = (await VaultWriteTool.call(
    { note: 'Board', content: 'x', mode: 'append' } as never,
    {} as never,
  )) as { data: { text: string; isError?: boolean } }
  check(
    'append into a canvas is refused, not corrupted',
    refused.data.isError === true && /edit it in Obsidian/.test(refused.data.text),
    refused.data,
  )
  rmSync(join(vaultDir, 'Board.canvas'))
}

// ─── Trash: "delete" the Obsidian way ───────────────────────────────────

{
  const { trashNoteFile } = await import('../src/main/obsidian/tools.js')
  writeFileSync(join(vaultDir, 'Doomed.md'), 'обречена\n')
  const before = allNotes().length
  const landed = trashNoteFile(vaultDir, 'Doomed.md')
  check('a trashed note leaves the index', allNotes().length === before - 1)
  check('…and lands inside .trash, recoverable', landed === 'Doomed.md')
  // Same name trashed again must not clobber the first copy.
  writeFileSync(join(vaultDir, 'Doomed.md'), 'вторая жизнь\n')
  const second = trashNoteFile(vaultDir, 'Doomed.md')
  check('a name collision in trash gets a suffix, never a clobber', second !== 'Doomed.md', second)
}

// ─── Registry toggles ───────────────────────────────────────────────────

{
  const id = listVaults()[0].id
  updateVault(id, { enabled: false })
  check('a disabled vault vanishes from the tools', allNotes().length === 0 && !hasEnabledVaults())
  check('…and the directive goes silent', buildVaultPrompt() === null)
  updateVault(id, { enabled: true, readOnly: true })
  check('read-only survives the round trip', listVaults()[0].readOnly === true)
  removeVault(id)
  check('remove forgets the pointer', listVaults().length === 0)
}

rmSync(tempData, { recursive: true, force: true })
rmSync(vaultDir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL OBSIDIAN CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
