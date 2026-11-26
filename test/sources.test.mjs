// Tests for ticket sources: the Switchboard converter (sources/switchboard.mjs),
// collection validation, the refresh turn's argv, buildFactory over a source
// file, and refreshSource for both kinds. `run` is injected, so no test ever
// spawns Claude. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the
// imports, so no test ever touches the real data/ folder.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sources-test-'))
const { DATA_DIR } = await import('../flows.mjs')
const { CONFIG } = await import('../config.mjs')
const { convert } = await import('../sources/switchboard.mjs')
const { makeSources, validateCollection, sourceArgs } = await import('../factory.mjs')
const { readSpend } = await import('../spend.mjs')
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

const SOURCES = path.join(DATA_DIR, 'sources')
const sourceFile = id => path.join(SOURCES, `${id}.json`)
const writeSource = (id, tickets) => {
  fs.mkdirSync(SOURCES, { recursive: true })
  fs.writeFileSync(sourceFile(id), JSON.stringify({ fetchedAt: '2026-11-12T09:00:00.000Z', me: 'u1', tickets }))
}
const ticket = (id, more = {}) => ({ id, title: `Title ${id}`, state: 'Started', column: 'CurrentSprint', owner: 'none', order: 1, labels: [], type: 'feature', url: '', ...more })

const SB_TOOL = 'mcp__switchboard-claude__list_stories'
const sb = (id, more = {}) => ({ id, name: id, kind: 'switchboard', project: 'p1', tools: [SB_TOOL], refreshMinutes: 0, ...more })
const agent = (id, more = {}) => ({ id, name: id, kind: 'agent', ask: 'Read every card.', tools: ['mcp__playwright__*'], refreshMinutes: 0, ...more })

// ═══ convert ═══

const story = more => ({ storyId: 'ABC-1', title: 'T', state: 'None', status: 'Icebox', ownerIds: ['u1'], order: 5, labels: ['x'], storyType: 'bug', ...more })

test('convert turns a Switchboard story into a normalised ticket', () => {
  const src = convert([story()], 'u1')
  assert.deepEqual(src.tickets['ABC-1'], { id: 'ABC-1', title: 'T', state: 'Unstarted', column: 'Icebox', owner: 'me', order: 5, labels: ['x'], type: 'bug', url: '' })
  assert.equal(src.me, 'u1')
  assert.ok(!Number.isNaN(Date.parse(src.fetchedAt)))
})

test('convert sets owner none, other or me from ownerIds', () => {
  assert.equal(convert([story({ ownerIds: [] })], 'u1').tickets['ABC-1'].owner, 'none')
  assert.equal(convert([story({ ownerIds: ['u2'] })], 'u1').tickets['ABC-1'].owner, 'other')
  assert.equal(convert([story({ ownerIds: ['u2', 'u1'] })], 'u1').tickets['ABC-1'].owner, 'me')
  assert.equal(convert([story({ ownerIds: undefined })], 'u1').tickets['ABC-1'].owner, 'none')
})

test('convert skips a story with no storyId, and an empty or missing state is Unstarted', () => {
  const src = convert([story({ storyId: undefined }), story({ storyId: 'abc-2', state: '' }), story({ storyId: 'ABC-3', state: undefined, order: undefined }), story({ storyId: 'ABC-4', state: 'Started' })], 'u1')
  assert.deepEqual(Object.keys(src.tickets), ['ABC-2', 'ABC-3', 'ABC-4'])
  assert.equal(src.tickets['ABC-2'].state, 'Unstarted')
  assert.equal(src.tickets['ABC-3'].state, 'Unstarted')
  assert.equal(src.tickets['ABC-3'].order, null)
  assert.equal(src.tickets['ABC-4'].state, 'Started')
})

// ═══ collection validation ═══

test('a collection on a timer whose tools can act is refused', () => {
  assert.throws(() => validateCollection(agent('xyz', { refreshMinutes: 20 })), /^Error: Collection xyz: refreshMinutes must be 0 because its tools can act: mcp__playwright__\*$/)
  assert.doesNotThrow(() => validateCollection(agent('xyz', { refreshMinutes: 0 })))
  assert.doesNotThrow(() => validateCollection(sb('prod', { refreshMinutes: 20 })))
  assert.doesNotThrow(() => validateCollection(agent('lin', { tools: ['mcp__linear__list_issues', 'mcp__linear__get_issue', 'search_x', 'read_y'], refreshMinutes: 5 })))
  assert.throws(() => validateCollection(agent('lin', { tools: ['mcp__linear__list_issues', 'mcp__linear__update_issue'], refreshMinutes: 5 })), /can act: mcp__linear__update_issue/)
})

test('a switchboard collection needs a project and one tool; an agent one needs an ask and a tool', () => {
  assert.throws(() => validateCollection(sb('prod', { project: '' })), /Collection prod: .*project/)
  assert.throws(() => validateCollection(sb('prod', { tools: [] })), /Collection prod: .*one tool/)
  assert.throws(() => validateCollection(sb('prod', { tools: [SB_TOOL, 'mcp__switchboard-claude__get_story_details'] })), /Collection prod: .*one tool/)
  assert.throws(() => validateCollection(agent('xyz', { ask: '' })), /Collection xyz: .*ask/)
  assert.throws(() => validateCollection(agent('xyz', { tools: [] })), /Collection xyz: .*at least one tool/)
  assert.throws(() => validateCollection(sb('prod', { kind: 'jira' })), /Collection prod: kind/)
  assert.throws(() => validateCollection({ kind: 'agent', ask: 'x', tools: ['t'] }), /id/)
  assert.throws(() => validateCollection(sb('prod', { filter: { prefix: 'ABC', range: [5] } })), /Collection prod: .*range/)
  assert.throws(() => makeSources({ collections: [sb('prod'), sb('prod')], run: async () => ({}) }), /Collection prod: .*twice/)
})

test('a collection with no refreshMinutes refreshes by button only', () => {
  const { refreshMinutes, ...rest } = agent('xyz')
  assert.equal(validateCollection(rest).refreshMinutes, 0)
})

// ═══ the refresh turn's argv ═══

test('a switchboard turn gets no built-in tools and only its one MCP tool', () => {
  const args = sourceArgs(sb('prod'), 'the prompt', 'm1')
  assert.deepEqual(args, ['-p', '--model', 'm1', '--tools', '', '--allowedTools', SB_TOOL, '--no-session-persistence', '--output-format', 'json', 'the prompt'])
})

test('an agent turn gets Write plus its own tools, and writes through acceptEdits with no Write rule', () => {
  const args = sourceArgs(agent('xyz', { tools: ['mcp__playwright__*', 'mcp__x__list_y'] }), 'the prompt', 'm1')
  assert.deepEqual(args, [
    '-p', '--model', 'm1',
    '--tools', 'Write,mcp__playwright__*,mcp__x__list_y',
    '--allowedTools', 'mcp__playwright__*', 'mcp__x__list_y',
    '--permission-mode', 'acceptEdits',
    '--no-session-persistence', '--output-format', 'json', 'the prompt',
  ])
  assert.equal(args.some(a => a.startsWith('Write(') || a === '--add-dir'), false)
})

// ═══ buildFactory over a source file ═══

test('buildFactory with a filter shows the range plus extras, with owner from the source', async () => {
  writeSource('prod', {
    'ABC-1': ticket('ABC-1', { owner: 'me', labels: ['Security'] }),
    'ABC-2': ticket('ABC-2', { owner: 'other', state: 'Unstarted', column: 'Icebox' }),
    'ABC-5': ticket('ABC-5'),
    'ABC-9': ticket('ABC-9', { owner: 'none' }),
  })
  const S = makeSources({ collections: [sb('prod', { filter: { prefix: 'ABC', range: [1, 2], extras: [9] } }), sb('all')], run: async () => ({}) })
  const f = await S.buildFactory('prod')
  assert.deepEqual(f.tickets.map(t => t.id), ['ABC-1', 'ABC-2', 'ABC-9'])
  assert.deepEqual(f.tickets.map(t => t.owner), ['me', 'other', 'none'])
  assert.deepEqual(f.tickets.map(t => t.extra), [false, false, true])
  assert.deepEqual(f.tickets[0], { id: 'ABC-1', n: 1, title: 'Title ABC-1', state: 'Started', column: 'CurrentSprint', phase: 'Security', owner: 'me', order: 1, type: 'feature', extra: false, plan: null, mark: f.tickets[0].mark })
  assert.equal(f.snapshotAt, '2026-11-12T09:00:00.000Z')
  assert.deepEqual(f.collection, { id: 'prod', name: 'prod', kind: 'switchboard', prefix: 'ABC', range: [1, 2], planFile: '' })
  assert.deepEqual(f.collections, [{ id: 'prod', name: 'prod' }, { id: 'all', name: 'all' }])
  assert.deepEqual(f.refresh, { id: 'prod', running: false, at: null, ok: null, message: '', everyMinutes: 0, paused: false })
  assert.equal('decisions' in f, false)
})

test('buildFactory without a filter shows every ticket, by column then order', async () => {
  writeSource('all', {
    'A-1': ticket('A-1', { column: 'Icebox', order: 1 }),
    'A-2': ticket('A-2', { column: 'Done', order: 0 }),
    'A-3': ticket('A-3', { column: 'CurrentSprint', order: 7 }),
    'A-4': ticket('A-4', { column: 'Backlog', order: 2 }),
    'A-5': ticket('A-5', { column: 'CurrentSprint', order: 3 }),
    'A-6': ticket('A-6', { column: 'CurrentSprint', order: null }),
  })
  const S = makeSources({ collections: [sb('all')], run: async () => ({}) })
  const f = await S.buildFactory('all')
  assert.deepEqual(f.tickets.map(t => t.id), ['A-5', 'A-3', 'A-6', 'A-4', 'A-1', 'A-2'])
  assert.deepEqual(f.collection, { id: 'all', name: 'all', kind: 'switchboard', prefix: '', range: null, planFile: '' })
})

test('buildFactory with no source file yet shows the filter ids with no data, and an unknown id falls back to the first collection', async () => {
  const S = makeSources({ collections: [sb('none-yet', { filter: { prefix: 'X', range: [1, 1] } })], run: async () => ({}) })
  const f = await S.buildFactory('nope')
  assert.equal(f.collection.id, 'none-yet')
  assert.deepEqual(f.tickets.map(t => [t.id, t.state, t.owner]), [['X-1', 'Unstarted', 'none']])
  assert.equal(f.snapshotAt, null)
  assert.equal(S.readSource('none-yet'), null)
})

test('readSource drops a ticket whose key or id is not a ticket id, so markup never reaches the page', async () => {
  writeSource('crafted', {
    '<img src=x onerror=alert(1)>': ticket('<img src=x onerror=alert(1)>'),
    'X-1"><script>alert(1)</script>': ticket('X-1'),
    'X-2': ticket('<script>alert(2)</script>'),
    'X-3': 'not an object',
    'X-4': ticket('X-4'),
  })
  const S = makeSources({ collections: [agent('crafted')], run: async () => ({}) })
  assert.deepEqual(Object.keys(S.readSource('crafted').tickets), ['X-4'])
  assert.deepEqual((await S.buildFactory('crafted')).tickets.map(t => t.id), ['X-4'])
})

test('readSource turns a non-string title, state, column or owner into text, so the page render never crashes', async () => {
  writeSource('odd', { 'X-1': ticket('X-1', { title: 42, state: { evil: 1 }, column: ['CurrentSprint'], owner: 7 }), 'X-2': ticket('X-2', { state: 5 }) })
  const S = makeSources({ collections: [agent('odd')], run: async () => ({}) })
  const t = S.readSource('odd').tickets['X-1']
  for (const k of ['title', 'state', 'column', 'owner']) assert.equal(typeof t[k], 'string', k)
  const f = await S.buildFactory('odd')
  for (const row of f.tickets) assert.equal(typeof row.state, 'string')
  assert.equal(f.tickets.find(r => r.id === 'X-2').state, '5')
})

test('convert drops a story whose storyId is not a ticket id, and turns odd fields into text', () => {
  const src = convert([story({ storyId: '<img src=x onerror=alert(1)>' }), story({ storyId: 'ABC-7', title: 3, state: 4, status: null })], 'u1')
  assert.deepEqual(Object.keys(src.tickets), ['ABC-7'])
  assert.equal(src.tickets['ABC-7'].title, '3')
  assert.equal(src.tickets['ABC-7'].state, '4')
  assert.equal(src.tickets['ABC-7'].column, '')
})

// ═══ refreshSource ═══

test('an agent refresh that writes a valid file is ok, with the ticket count', async () => {
  const seen = []
  const run = async (args, opts) => {
    seen.push(args)
    assert.equal(opts.cwd, SOURCES) // acceptEdits only writes inside the cwd: the sources folder, never the repo
    assert.ok(fs.statSync(opts.cwd).isDirectory())
    writeSource('xyz', { 'XYZ-1': ticket('XYZ-1'), 'XYZ-2': ticket('XYZ-2') })
    return { ok: true, out: '2', err: '' }
  }
  const S = makeSources({ collections: [agent('xyz')], run, me: 'u9' })
  const r = await S.refreshSource('xyz')
  assert.equal(r.ok, true, r.message)
  assert.match(r.message, /\d+ tickets/)
  assert.match(r.message, /^2 tickets/)
  assert.equal(r.running, false)
  assert.equal(r.id, 'xyz')
  const prompt = seen[0].at(-1)
  assert.ok(prompt.startsWith('Read every card. Write the result to '))
  assert.ok(prompt.includes(path.join(DATA_DIR, 'sources', 'xyz.json').replace(/\\/g, '/')))
  assert.ok(prompt.includes('"me": "u9"'))
  assert.ok(prompt.endsWith('Reply with only the number of tickets written.'))
  assert.deepEqual(Object.keys(S.readSource('xyz').tickets), ['XYZ-1', 'XYZ-2'])
  assert.deepEqual(S.refreshStatus('xyz'), r)
})

test('an agent refresh that writes nothing is not ok, and the old file stays', async () => {
  writeSource('quiet', { 'Q-1': ticket('Q-1') })
  const S = makeSources({ collections: [agent('quiet')], run: async () => ({ ok: true, out: '0', err: '' }) })
  const r = await S.refreshSource('quiet')
  assert.equal(r.ok, false)
  assert.match(r.message, /did not write/)
  assert.deepEqual(Object.keys(S.readSource('quiet').tickets), ['Q-1'])
})

test('an agent refresh that writes a file with no tickets is not ok, and the last good file comes back', async () => {
  writeSource('bad', { 'B-1': ticket('B-1') })
  const S = makeSources({ collections: [agent('bad')], run: async () => (fs.writeFileSync(sourceFile('bad'), '{"fetchedAt":"x"}'), { ok: true, out: '0', err: '' }) })
  const r = await S.refreshSource('bad')
  assert.equal(r.ok, false)
  assert.match(r.message, /tickets/)
  assert.deepEqual(Object.keys(S.readSource('bad').tickets), ['B-1'])
})

test('an agent refresh that writes broken JSON on a first run is not ok and leaves no file', async () => {
  const S = makeSources({ collections: [agent('fresh')], run: async () => (fs.mkdirSync(SOURCES, { recursive: true }), fs.writeFileSync(sourceFile('fresh'), '{not json'), { ok: true, out: '1', err: '' }) })
  const r = await S.refreshSource('fresh')
  assert.equal(r.ok, false)
  assert.equal(fs.existsSync(sourceFile('fresh')), false)
})

test('a switchboard refresh converts the dump, writes the source and deletes the dump', async () => {
  const dump = path.join(DATA_DIR, 'tool-results', 'mcp-switchboard-claude-list_stories-1.txt')
  fs.mkdirSync(path.dirname(dump), { recursive: true })
  fs.writeFileSync(dump, JSON.stringify([story(), story({ storyId: 'ABC-2', ownerIds: [] })]))
  const seen = []
  const cwds = []
  const run = async (args, opts) => (seen.push(args), cwds.push(opts.cwd), { ok: true, out: `Saved to:\n${dump}\n`, err: '' })
  const S = makeSources({ collections: [sb('sbx', { project: 'proj-9' })], run, me: 'u1' })
  const r = await S.refreshSource('sbx')
  assert.equal(r.ok, true, r.message)
  assert.match(r.message, /^2 tickets/)
  assert.equal(fs.existsSync(dump), false)
  assert.deepEqual(cwds, [CONFIG.repo]) // the repo, where the Switchboard MCP server is configured
  assert.match(seen[0].at(-1), new RegExp(`^Call ${SB_TOOL} with projectId proj-9\\.`))
  const src = S.readSource('sbx')
  assert.equal(src.me, 'u1')
  assert.deepEqual(src.tickets['ABC-1'].owner, 'me')
  assert.deepEqual(src.tickets['ABC-2'].owner, 'none')
  assert.equal(fs.readdirSync(SOURCES).some(n => n.endsWith('.tmp')), false)
})

// ═══ the json reply: the model's text is in .result, its cost is refresh spend (spend.mjs) ═══

/** The stdout of a `-p --output-format json` turn that replied `text` at `usd`. */
const jsonOut = (text, usd) => JSON.stringify({ type: 'result', is_error: false, result: text, total_cost_usd: usd })
const refreshSpent = () => readSpend().byKind.refresh

test('a switchboard refresh finds the dump path inside a json reply (a Windows path, escaped in JSON) and records the cost', async () => {
  const dump = path.join(DATA_DIR, 'tool-results', 'mcp-switchboard-claude-list_stories-2.txt')
  fs.mkdirSync(path.dirname(dump), { recursive: true })
  fs.writeFileSync(dump, JSON.stringify([story()]))
  const before = refreshSpent()
  const S = makeSources({ collections: [sb('sbjson')], run: async () => ({ ok: true, out: jsonOut(dump, 0.0731), err: '' }), me: 'u1' })
  const r = await S.refreshSource('sbjson')
  assert.equal(r.ok, true, r.message)
  assert.match(r.message, /^1 tickets/)
  assert.equal(fs.existsSync(dump), false)
  assert.ok(Math.abs(refreshSpent() - before - 0.0731) < 1e-9)
})

test('an agent refresh records the cost of its turn, even when the turn wrote nothing', async () => {
  const before = refreshSpent()
  const S = makeSources({ collections: [agent('agjson')], run: async () => ({ ok: true, out: jsonOut('0', 0.5), err: '' }) })
  const r = await S.refreshSource('agjson')
  assert.equal(r.ok, false)
  assert.match(r.message, /did not write/)
  assert.ok(!r.message.includes('total_cost_usd'), 'the message carries the reply text, not the raw json')
  assert.ok(Math.abs(refreshSpent() - before - 0.5) < 1e-9)
})

test('a refresh reply that is not JSON records no cost', async () => {
  const before = refreshSpent()
  const S = makeSources({ collections: [agent('agtext')], run: async () => ({ ok: true, out: '0', err: '' }) })
  await S.refreshSource('agtext')
  assert.equal(refreshSpent(), before)
})

test('a switchboard refresh with no dump path in the reply is not ok, and two calls share one turn', async () => {
  let turns = 0
  const S = makeSources({ collections: [sb('nopath')], run: async () => (turns++, { ok: false, out: '', err: 'no MCP server' }) })
  const [a, b] = await Promise.all([S.refreshSource('nopath'), S.refreshSource('nopath')])
  assert.equal(turns, 1)
  assert.equal(a.ok, false)
  assert.match(a.message, /no MCP server/)
  assert.deepEqual(a, b)
})

test('refreshing an unknown collection is not ok', async () => {
  const S = makeSources({ collections: [], run: async () => ({}) })
  const r = await S.refreshSource('ghost')
  assert.equal(r.ok, false)
  assert.match(r.message, /ghost/)
})

test('startAutoRefresh sets one unref timer per collection with refreshMinutes above 0', () => {
  const S = makeSources({ collections: [sb('a', { refreshMinutes: 20 }), agent('b'), sb('c', { refreshMinutes: 5 })], run: async () => ({}) })
  const timers = S.startAutoRefresh()
  try {
    assert.equal(timers.length, 2)
    assert.ok(timers.every(t => t.hasRef() === false))
  } finally {
    timers.forEach(clearInterval)
  }
})

// ═══ the previous state, for Since you were away (spec F2) ═══

test('a refresh notes each ticket whose state changed in sources/<id>.prev.json', async () => {
  writeSource('prevx', { 'ABC-1': ticket('ABC-1', { state: 'Started' }), 'ABC-2': ticket('ABC-2', { state: 'Started' }) })
  const run = async () => (writeSource('prevx', { 'ABC-1': ticket('ABC-1', { state: 'Finished' }), 'ABC-2': ticket('ABC-2', { state: 'Started' }) }), { ok: true, out: '2', err: '' })
  const S = makeSources({ collections: [agent('prevx')], run })
  const r = await S.refreshSource('prevx')
  assert.equal(r.ok, true, r.message)
  const prev = JSON.parse(fs.readFileSync(path.join(SOURCES, 'prevx.prev.json'), 'utf8'))
  assert.deepEqual(Object.keys(prev.tickets), ['ABC-1'])
  assert.equal(prev.tickets['ABC-1'].state, 'Started')
  assert.ok(!Number.isNaN(Date.parse(prev.tickets['ABC-1'].at)))
  assert.equal(prev.fetchedAt, '2026-11-12T09:00:00.000Z', 'the replaced file is the one it came from')
})

test('a failed refresh notes nothing', async () => {
  writeSource('prevy', { 'ABC-1': ticket('ABC-1') })
  const S = makeSources({ collections: [agent('prevy')], run: async () => (fs.writeFileSync(sourceFile('prevy'), '{"fetchedAt":"x"}'), { ok: true, out: '0', err: '' }) })
  assert.equal((await S.refreshSource('prevy')).ok, false)
  assert.equal(fs.existsSync(path.join(SOURCES, 'prevy.prev.json')), false)
})

test('a prev file never shows as a collection source', async () => {
  fs.mkdirSync(SOURCES, { recursive: true })
  fs.writeFileSync(path.join(SOURCES, 'prevz.prev.json'), JSON.stringify({ fetchedAt: 'x', tickets: { 'ABC-1': { state: 'Started', at: 'x' } } }))
  const S = makeSources({ collections: [agent('prevz')], run: async () => ({ ok: true, out: '', err: '' }) })
  assert.equal(S.readSource('prevz'), null)
})

test('a switchboard turn that ends in an error shows the model text, not the exit code', async () => {
  const out = JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 529 Overloaded', total_cost_usd: 0.001 })
  const S = makeSources({ collections: [sb('sberr')], run: async () => ({ ok: false, out, err: 'exited with code 1' }), me: 'u1' })
  const r = await S.refreshSource('sberr')
  assert.equal(r.ok, false)
  assert.match(r.message, /API Error: 529 Overloaded/)
  assert.doesNotMatch(r.message, /exited with code 1/)
})
