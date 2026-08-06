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

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from 'node:fs'
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
const { allNotes, buildGraph, resolveNote, searchNotes, backlinksTo, vaultStats } =
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

// ─── The graph ──────────────────────────────────────────────────────────

{
  const g = buildGraph(allNotes())
  check('every note is a node', g.nodes.length === 4, g.nodes.length)
  // Attention ⇄ Scaling Laws (both directions are real links) plus the
  // edited root Self-Attention → Attention. Attention → Self-Attention is
  // AMBIGUOUS (two notes share the name) and draws nothing rather than
  // guessing.
  check(
    'edges resolve through names; ambiguous targets draw nothing',
    g.edges.length === 3,
    g.edges,
  )
  const hub = g.nodes.find((n) => n.name === 'Attention')
  check('degree lands on the hub', hub?.links === 3, hub?.links)
  const dupes = g.nodes.filter((n) => n.name === 'Self-Attention')
  check('same-named notes stay separate nodes', dupes.length === 2)
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

// ─── Attachments: pictures, video, anything not prose ───────────────────

{
  const {
    attachmentFolder,
    attachmentKind,
    copyIntoVault,
    embedMarkdown,
    freeName,
    safeAttachmentName,
  } = await import('../src/main/obsidian/attachments.js')

  check(
    'kinds decide how a file is referenced',
    attachmentKind('a.PNG') === 'image' &&
      attachmentKind('clip.mp4') === 'video' &&
      attachmentKind('take.mp3') === 'audio' &&
      attachmentKind('paper.pdf') === 'file',
  )
  check(
    'media embeds, other kinds link',
    embedMarkdown('a.png', 'image') === '![[a.png]]' &&
      embedMarkdown('p.pdf', 'file') === '[[p.pdf]]',
  )
  check(
    'only what a filesystem forbids is replaced',
    safeAttachmentName('C:/tmp/my photo:v2.png') === 'my photo_v2.png',
    safeAttachmentName('C:/tmp/my photo:v2.png'),
  )
  // The bug this pins down: hyphens were being eaten, so a picture the model
  // had just named 00-cover.jpg landed as 00_cover.jpg and every embed it
  // wrote pointed at nothing.
  check(
    'a hyphenated name survives verbatim',
    safeAttachmentName('kimi-article-img/00-cover.jpg') === '00-cover.jpg',
    safeAttachmentName('kimi-article-img/00-cover.jpg'),
  )
  check(
    'a windows path is reduced to its basename',
    safeAttachmentName('C:\\work\\img\\shot-1.png') === 'shot-1.png',
    safeAttachmentName('C:\\work\\img\\shot-1.png'),
  )

  const vault = listVaults()[0]
  // No .obsidian/app.json yet → the vault root, Obsidian's own default.
  check('with no vault config, attachments land at the root', attachmentFolder(vault) === '')
  mkdirSync(join(vaultDir, '.obsidian'), { recursive: true })
  writeFileSync(
    join(vaultDir, '.obsidian', 'app.json'),
    JSON.stringify({ attachmentFolderPath: 'assets' }),
  )
  check("a vault's own folder setting is honoured", attachmentFolder(vault) === 'assets')
  writeFileSync(
    join(vaultDir, '.obsidian', 'app.json'),
    JSON.stringify({ attachmentFolderPath: './files' }),
  )
  check(
    'the per-note form lands BESIDE the note',
    attachmentFolder(vault, 'projects/Scaling Laws.md') === 'projects/files',
    attachmentFolder(vault, 'projects/Scaling Laws.md'),
  )
  writeFileSync(
    join(vaultDir, '.obsidian', 'app.json'),
    JSON.stringify({ attachmentFolderPath: 'assets' }),
  )

  // The copy itself.
  const srcDir = mkdtempSync(join(tmpdir(), 'obsidian-probe-src-'))
  const png = join(srcDir, 'plot.png')
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  const first = copyIntoVault(vault, png)
  check('the file lands in the vault, in its folder', first.relPath === 'assets/plot.png', first)
  check('and is reported as an image', first.kind === 'image' && first.bytes === 7, first)
  const second = copyIntoVault(vault, png)
  check(
    'a second copy never clobbers the first',
    second.relPath === 'assets/plot-1.png' && existsSync(join(vaultDir, 'assets', 'plot.png')),
    second,
  )
  check(
    'freeName is what decides that',
    freeName(join(vaultDir, 'assets'), 'plot.png') === 'plot-2.png',
  )
  check(
    'no temp file is left behind',
    !readdirSync(join(vaultDir, 'assets')).some((f) => f.includes('monet-tmp')),
    readdirSync(join(vaultDir, 'assets')),
  )
  // Attachments are not notes: the index must not adopt them.
  check(
    'the index ignores attachments',
    !allNotes().some((n) => n.name === 'plot'),
    allNotes().map((n) => n.name),
  )
  rmSync(srcDir, { recursive: true, force: true })
  rmSync(join(vaultDir, 'assets'), { recursive: true, force: true })
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

// ─── Link rewriting and surgical edits (pure) ───────────────────────────

{
  const { rewriteLinks, referencesName, applyEdit } = await import(
    '../src/main/obsidian/links.js'
  )

  const src = [
    'обложка ![[00-cover.jpg]] и ссылка [[00-cover.jpg|подпись]]',
    'путь ![[assets/00-cover.jpg]] и markdown ![alt](00-cover.jpg)',
    'чужой файл ![[other.jpg]] и внешний ![web](https://x.dev/00-cover.jpg)',
  ].join('\n')
  const r = rewriteLinks(src, { from: '00-cover.jpg', to: 'assets/cover.jpg' })
  check('every reference to the old name is rewritten', r.count === 4, r.count)
  check('a bare name stays bare', r.text.includes('![[cover.jpg]]'), r.text)
  check('…and an aliased link keeps its alias', r.text.includes('[[cover.jpg|подпись]]'))
  check('a path reference becomes the new path', r.text.includes('![[assets/cover.jpg]]'))
  check('a markdown link is rewritten too', r.text.includes('![alt](cover.jpg)'))
  check('another file is left alone', r.text.includes('![[other.jpg]]'))
  check('an http url is not a vault path', r.text.includes('https://x.dev/00-cover.jpg'))

  check('the pre-filter sees a reference by basename', referencesName(src, 'assets/00-cover.jpg'))
  check('…and says no when there is none', !referencesName(src, 'nothing.png'))

  const note = 'до\nПОМЕТКА\nпосле\nПОМЕТКА\n'
  const uniq = applyEdit('раз\nдва\nтри\n', 'два', 'ДВА')
  check('a unique edit lands', uniq.ok && uniq.text === 'раз\nДВА\nтри\n', uniq)
  const dup = applyEdit(note, 'ПОМЕТКА', 'X')
  check('an ambiguous edit refuses rather than guessing', !dup.ok, dup)
  const all = applyEdit(note, 'ПОМЕТКА', 'X', true)
  check('…unless replace_all was asked for', all.ok && all.count === 2, all)
  check('a missing old_string is an error', !applyEdit('текст', 'нет', 'да').ok)
  check('an empty old_string is an error', !applyEdit('текст', '', 'да').ok)
  check('a no-op edit is an error', !applyEdit('текст', 'текст', 'текст').ok)
}

// ─── Where attachments land ─────────────────────────────────────────────

{
  const { attachmentFolder } = await import('../src/main/obsidian/attachments.js')
  const base = { id: 'x', name: 'V', path: vaultDir, enabled: true, readOnly: false }
  mkdirSync(join(vaultDir, '.obsidian'), { recursive: true })
  writeFileSync(
    join(vaultDir, '.obsidian', 'app.json'),
    JSON.stringify({ attachmentFolderPath: 'obsidian-attachments' }),
  )
  check(
    "without an override the vault's own setting is used",
    attachmentFolder(base) === 'obsidian-attachments',
    attachmentFolder(base),
  )
  check(
    'the app setting wins over the vault config',
    attachmentFolder({ ...base, attachmentFolder: 'media/pictures' }) === 'media/pictures',
    attachmentFolder({ ...base, attachmentFolder: 'media/pictures' }),
  )
  check(
    'an override of "/" means the root, explicitly',
    attachmentFolder({ ...base, attachmentFolder: '/' }) === '',
  )
  check(
    'a per-note override lands beside the note',
    attachmentFolder({ ...base, attachmentFolder: './assets' }, 'Проекты/Заметка.md') ===
      'Проекты/assets',
    attachmentFolder({ ...base, attachmentFolder: './assets' }, 'Проекты/Заметка.md'),
  )
  rmSync(join(vaultDir, '.obsidian'), { recursive: true, force: true })
}

// ─── Moving a file, links and all ───────────────────────────────────────

{
  const { VaultMoveTool, VaultEditTool } = await import('../src/main/obsidian/tools.js')
  const call = async (tool: unknown, input: unknown): Promise<string> => {
    const r = await (tool as { call: (i: unknown) => Promise<{ data: { text: string } }> }).call(
      input,
    )
    return r.data.text
  }
  writeFileSync(join(vaultDir, 'pic-one.png'), 'not really a png')
  writeFileSync(
    join(vaultDir, 'Статья.md'),
    'Вступление.\n\n![[pic-one.png]]\n\nКонец.\n',
  )

  const moved = await call(VaultMoveTool, { from: 'pic-one.png', to: 'assets/' })
  check('a file moves into a folder', existsSync(join(vaultDir, 'assets', 'pic-one.png')), moved)
  check('…and the old copy is gone', !existsSync(join(vaultDir, 'pic-one.png')))
  check(
    'a same-name move leaves the links alone (Obsidian resolves by name)',
    moved.includes('No references needed changing'),
    moved,
  )

  const renamed = await call(VaultMoveTool, {
    from: 'assets/pic-one.png',
    to: 'assets/обложка.png',
  })
  const article = readFileSync(join(vaultDir, 'Статья.md'), 'utf-8')
  check('a rename rewrites the embed', article.includes('![[обложка.png]]'), article)
  check('…and says how many references it touched', renamed.includes('1 reference'), renamed)
  check('moving something that is not there is an error, not a crash',
    (await call(VaultMoveTool, { from: 'нет-такого.png', to: 'x/' })).includes('Nothing named'))

  const edited = await call(VaultEditTool, {
    note: 'Статья',
    old_string: 'Вступление.',
    new_string: 'Начало.',
  })
  check(
    'VaultEdit changes one place and leaves the rest',
    readFileSync(join(vaultDir, 'Статья.md'), 'utf-8') ===
      'Начало.\n\n![[обложка.png]]\n\nКонец.\n',
    { said: edited, file: readFileSync(join(vaultDir, 'Статья.md'), 'utf-8') },
  )
  check(
    '…on top of the rewrite the rename just made, not a stale copy',
    readFileSync(join(vaultDir, 'Статья.md'), 'utf-8').includes('![[обложка.png]]'),
  )

  // The same thing, made deterministic. The index trusts mtime, so two
  // writes inside one filesystem tick are indistinguishable to it — here
  // that tick is forced with utimes. Without invalidatePath the second read
  // returns the FIRST version, and a rename-then-edit silently undoes the
  // rename. On a fast disk this only shows up as an occasional flake.
  {
    const { invalidatePath } = await import('../src/main/obsidian/index.js')
    const abs = join(vaultDir, 'Тик.md')
    writeFileSync(abs, 'первая\n')
    const stamp = new Date(Date.now() - 1000)
    utimesSync(abs, stamp, stamp)
    check(
      'the index reads a new note',
      allNotes().find((n) => n.name === 'Тик')?.raw === 'первая\n',
    )
    writeFileSync(abs, 'вторая\n')
    utimesSync(abs, stamp, stamp)
    check(
      'with an unchanged mtime the cached copy is what you get',
      allNotes().find((n) => n.name === 'Тик')?.raw === 'первая\n',
    )
    invalidatePath(abs)
    check(
      '…until the write invalidates it — which is what every vault write does',
      allNotes().find((n) => n.name === 'Тик')?.raw === 'вторая\n',
      allNotes().find((n) => n.name === 'Тик')?.raw,
    )
    rmSync(abs, { force: true })
  }

  const missed = await call(VaultEditTool, {
    note: 'Статья',
    old_string: 'такого текста нет',
    new_string: 'x',
  })
  check('…and refuses when the text is not there', missed.includes('not found'), missed)

  rmSync(join(vaultDir, 'assets'), { recursive: true, force: true })
  rmSync(join(vaultDir, 'Статья.md'), { force: true })
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
