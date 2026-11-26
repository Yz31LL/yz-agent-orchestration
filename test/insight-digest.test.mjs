// Tests for the digest (insight-sections.mjs, insight-gather.mjs, insight-digest.mjs) and its inbox
// (insight-inbox.mjs): the six parts from SEEDED stores, in a stable order under stable headings; the size cap with
// the --section escape; a source that fails named as left out, never invented; the read marker. Temp folders only;
// no server, no git, no model.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-digest-test-'))
process.env.FACTORY_DATA_DIR = TMP
const { gatherDigest } = await import('../insight-gather.mjs')
const { renderDigest, DIGEST_MAX, SECTION_NAMES } = await import('../insight-digest.mjs')
const { pipelineGraph } = await import('../pipeline.mjs')
const inbox = await import('../insight-inbox.mjs')
await import('../public/predict-group.js')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const NOW = Date.parse('2026-11-26T12:00:00.000Z')
const H = 3_600_000
const iso = ms => new Date(ms).toISOString()
const CONFIG = { coordinatorLabel: 'Master', codingAgents: { Master: 'Master', a1: 'Agent 1', a2: 'Agent 2' }, pipeline: { qa: 'QA', security: 'Security' }, factory: { chat: { name: 'Independent' } } }
const graph = pipelineGraph(CONFIG)

const flow = (id, over = {}) => ({ id, title: `Title of ${id}`, agent: 'Agent 1', status: 'open', createdAt: iso(NOW - 5 * H), updatedAt: iso(NOW - 1 * H), nodes: [], tickets: [], ...over })
const FLOWS = [
  flow('build-login', { createdAt: iso(NOW - 3 * H) }),
  flow('ask-colour', { nodes: [{ id: 'n1', type: 'ask', title: 'Which colour for the button?', answer: null, at: iso(NOW - 2 * H) }] }),
  flow('stopped-one', { qa: { status: 'qa-failed', at: iso(NOW - 4 * H), attempts: [] }, updatedAt: iso(NOW - 4 * H) }),
  flow('shipped', { status: 'done', createdAt: iso(NOW - 30 * H), updatedAt: iso(NOW - 20 * H), qa: { status: 'passed', at: iso(NOW - 21 * H), pushedAt: iso(NOW - 20 * H), security: { status: 'passed', at: iso(NOW - 20.5 * H) }, attempts: [] }, nodes: [{ id: 'n1', type: 'step', title: 'code', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }] }] }),
]
const STATUS = { agents: [
  { label: 'Master', status: 'busy', state: 'active', model: 'claude-opus-5-5', subagents: [{ id: 'x', description: 'Explore the relay', state: 'working' }] },
  { label: 'Agent 1', status: 'idle', state: 'idle', model: 'claude-sonnet-5-5', subagents: [] },
] }
const SETTINGS = { agents: { 'Agent 1': { model: 'claude-sonnet-5-5', effort: 'medium', files: [] } } }
const HEALTH = { enabled: true, repairs: true, checks: [
  { id: 'refresh', name: 'Paid ticket refresh', state: 'failing', text: 'The ticket refresh failed 3 times and is paused. It has cost $52.32 since it last worked.' },
  { id: 'loops', name: 'Background loops', state: 'ok', text: 'Every loop beat in time.' },
], repairs24h: [{ at: iso(NOW - H), name: 'Paid ticket refresh', did: 'Paused the timer of Production checklist.', result: 'done' }] }
const SUGGESTIONS = { broken: false, list: [
  { id: 's000001', at: iso(NOW - 5 * H), by: 'Master', kind: 'rule', target: 'Agent 1', text: 'Run the suite before QA.', why: '4 of 9 failed.', effort: 'small', state: 'open', decidedAt: null, reason: '', outcome: '' },
  { id: 's000002', at: iso(NOW - 9 * H), by: 'Master', kind: 'setting', target: 'outputs.max', text: 'Lower outputs.max to 3.', why: '7 waited 3 days.', effort: '', state: 'rejected', decidedAt: iso(NOW - 2 * H), reason: 'I sign off on Fridays.', outcome: '' },
] }

const providers = (over = {}) => ({
  graph: () => graph, status: () => STATUS, settings: () => SETTINGS, flows: () => FLOWS,
  prs: () => [{ label: 'org/repo #12', title: 'Login page', checks: 'passing', needs: 'review', flow: { id: 'build-login' } }],
  tokens: () => ({ files: [], building: false, prices: {} }),
  alerts: () => ({ alerts: [{ key: 'stuck:a:qa', kind: 'stuck', text: 'build-login has been with QA for 5 h.', agent: 'QA' }], hidden: 0 }),
  group: globalThis.PredictGroup,
  lessons: () => [{ text: 'Test the empty list.', count: 4, area: 'tests', status: 'active' }],
  runs: () => [{ at: iso(NOW - 48 * H), ok: true, proposals: [{ target: 'QA', action: 'add', rule: 'Read the brief first.', state: 'rejected', reason: 'It does already.' }] }],
  verdicts: () => [{ label: 'Agent 1', by: 'learn', added: ['Write the test first.'], removed: [], state: 'waiting', dueAt: iso(NOW - H) }],
  outcomes: () => [{ followed: true, passedFirstTime: true }, { followed: false, passedFirstTime: false }],
  health: () => HEALTH,
  suggestions: () => SUGGESTIONS,
  inbox: () => ({ items: [{ at: iso(NOW - H), kind: 'health', text: 'Paid ticket refresh is failing.' }], readAt: iso(NOW - 3 * H) }),
  ...over,
})

test('the digest: the inbox first, then the six parts under stable headings in a fixed order, built from the seeded stores', async () => {
  const d = await gatherDigest(providers(), { now: NOW })
  const text = renderDigest({ ...d, by: 'Master' })
  assert.match(text.split('\n')[0], /^ORCHESTRATION DIGEST · 26 Nov \d\d:00 · read by Master$/)
  assert.match(text, /1 new since you last read \(26 Nov/)
  assert.match(text, /health: Paid ticket refresh is failing\./)
  const heads = text.split('\n').filter(l => /^== [A-Z]+ ==$/.test(l))
  assert.deepEqual(heads, SECTION_NAMES.map(n => `== ${n.toUpperCase()} ==`))
  assert.ok(text.length <= DIGEST_MAX)
  // Pipeline: the route, who is busy, the model set, the running subagent; a box with no session says so
  assert.match(text, /Route: Request > Master > Agent 1 \| Agent 2 > QA > Security > Human task > Push > Output/)
  assert.match(text, /Beside it: Independent, the chat agent/)
  assert.match(text, /Master \(coordinator\): busy · no model set \(its session decides\) · last reply on claude-opus-5-5 · 1 subagent running: Explore the relay/)
  assert.match(text, /Agent 1 \(producer\): idle · set to claude-sonnet-5-5 medium/)
  assert.match(text, /Agent 2 \(producer\): no session/)
  assert.match(text, /Security \(security\): no session · set to claude-opus-5-5 high \(fixed for this role\)/)
  // Work: open flows by stage with their age, what waits on the user, the gate stop, the pull request with its checks
  assert.match(text, /Open flows: 3, by where they stand/)
  assert.match(text, /Agent 1, producing: build-login \(3 h\)\n {2}On the user, a question is open: ask-colour \(2 h\)/)
  assert.match(text, /Waiting on the user: 1 question, 0 by-hand tasks, 0 blocked flows, 1 output to sign off\./)
  assert.match(text, /Question on ask-colour \(2 h\): Which colour for the button\?/)
  assert.match(text, /stopped-one: stopped by QA/)
  assert.match(text, /org\/repo #12 Login page · checks passing · needs review · flow build-login/)
  // Numbers: 7 and 30 days with the period before
  assert.match(text, /Score \(7 days; before = the 7 days before that\): precision 100% \(before no data\)/)
  assert.match(text, /Time \(30 days\): 1 finished \(before 0\)/)
  assert.match(text, /Tokens \(7 days\): 0/)
  // Signals: the alert in the shared words, a lesson, Learn and what the user did, the verdict due, routing
  assert.match(text, /Alerts: 1 \(1 flow far past its usual time\)/)
  assert.match(text, /Lessons hit most: "Test the empty list\." \(4, tests\)/)
  assert.match(text, /rejected: QA add "Read the brief first\."; the reason: It does already\./)
  assert.match(text, /Rule changes with a verdict due .*: 1\n  Agent 1 \(from Learn\): \+ Write the test first\./)
  assert.match(text, /Routing suggestions: followed 1 flow, right first time 100% of 1; not followed 1 flow, right first time 0% of 1/)
  // Health and Suggestions: the failing check first, the repair, the decided suggestion with its reason
  assert.match(text, /FAILING: Paid ticket refresh: The ticket refresh failed 3 times and is paused\. It has cost \$52\.32/)
  assert.match(text, /Repairs in the last 24 hours: 1\n.*Paused the timer of Production checklist\. \(done\)/)
  assert.match(text, /open s000001 \(rule, Agent 1\): Run the suite before QA\./)
  assert.match(text, /Decided since your last read: 1\n  s000002 rejected: I sign off on Fridays\./)
  assert.match(text, /Rejected, never propose these again:\n  s000002 outputs\.max: Lower outputs\.max to 3\./)
})

test('the size cap: a busy orchestration stays under 12,000 characters, and --section shows one part in full', async () => {
  const many = Array.from({ length: 300 }, (_, i) => flow(`flow-${String(i).padStart(3, '0')}`, { agent: ['Agent 1', 'Agent 2', 'Master'][i % 3], createdAt: iso(NOW - (i + 1) * 60_000), nodes: i % 4 ? [] : [{ id: 'n1', type: 'ask', title: `Question number ${i} about a long thing that needs words`, answer: null, at: iso(NOW - i * 60_000) }] }))
  const d = await gatherDigest(providers({ flows: () => many }), { now: NOW })
  const text = renderDigest(d)
  assert.ok(text.length <= DIGEST_MAX, `${text.length} characters`)
  assert.match(text, /… \d+ more lines: --section work shows all of it\./)
  const one = await gatherDigest(providers({ flows: () => many }), { now: NOW, only: 'work' })
  assert.deepEqual(Object.keys(one.sections), ['work'])
  const work = renderDigest({ ...one, only: 'work' })
  assert.match(work, /^== WORK ==/)
  assert.doesNotMatch(work, /more lines/)
  assert.equal((work.match(/^  Question on /gm) || []).length, 75)
  assert.ok(work.length > 5000, 'in full')
})

test('a source that fails is named as left out, never invented; the parts that can still be built are', async () => {
  const d = await gatherDigest(providers({ flows: () => { throw new Error('EACCES: the flows folder') }, status: () => null, prs: () => null, alerts: () => { throw new Error('no index') }, health: () => null }), { now: NOW })
  const text = renderDigest(d)
  assert.match(text, /== WORK ==\nLeft out: the flow files could not be read\./)
  assert.match(text, /== NUMBERS ==\nLeft out: the flow files could not be read\./)
  assert.match(text, /== HEALTH ==\nLeft out: the watchdog has not looked yet/)
  assert.match(text, /Left out: who is busy, idle or has no session: no session list was read/)
  assert.match(text, /Master \(coordinator\): state left out/)
  // pull requests: none read is not "0 open"
  const d2 = await gatherDigest(providers({ prs: () => null, alerts: () => null, tokens: () => null }), { now: NOW })
  const t2 = renderDigest(d2)
  assert.doesNotMatch(t2, /Open pull requests: 0/)
  assert.match(t2, /Left out: open pull requests and their checks/)
  assert.match(t2, /Left out: the alerts: they are worked out by the running dashboard only\./)
  assert.match(t2, /Left out: Pipeline tokens: the token index could not be read\./)
  assert.doesNotMatch(t2, /Tokens \(7 days\)/)
  // a thrown provider inside Signals is named, and the rest of Signals stays
  const d3 = await gatherDigest(providers({ lessons: () => { throw new Error('lessons.json is torn') } }), { now: NOW })
  const t3 = renderDigest(d3)
  assert.match(t3, /Left out: the lessons: lessons\.json is torn\./)
  assert.match(t3, /Alerts: 1/)
  // no graph at all: every part that needs it is left out with the reason
  const d4 = await gatherDigest(providers({ graph: () => { throw new Error('config') } }), { now: NOW })
  assert.match(renderDigest(d4), /== PIPELINE ==\nLeft out: the orchestration graph could not be read from config\.json\./)
})

test('the inbox: items after the read marker are new; marking read moves it, and an item added later stays new', () => {
  const file = path.join(TMP, 'inbox', 'master-inbox.jsonl')
  const stateFile = path.join(TMP, 'inbox', 'state.json')
  assert.deepEqual(inbox.unread({ file, stateFile }), { items: [], readAt: null })
  inbox.appendInbox({ kind: 'health', text: 'Paid ticket refresh is failing.' }, { file, now: NOW - 3000 })
  inbox.appendInbox({ kind: 'repair', text: 'Paused the refresh.' }, { file, now: NOW - 2000 })
  assert.equal(inbox.appendInbox({ kind: 'nonsense', text: 'x' }, { file }), null)
  assert.equal(inbox.appendInbox({ kind: 'health', text: '   ' }, { file }), null)
  assert.equal(inbox.unread({ file, stateFile }).items.length, 2)
  inbox.markRead(NOW - 1000, { stateFile })
  assert.deepEqual(inbox.unread({ file, stateFile }), { items: [], readAt: iso(NOW - 1000) })
  inbox.appendInbox({ kind: 'suggestion', text: 'The user rejected s000002.' }, { file, now: NOW })
  assert.deepEqual(inbox.unread({ file, stateFile }).items.map(i => i.kind), ['suggestion'])
  // never back
  inbox.markRead(NOW - 5000, { stateFile })
  assert.equal(inbox.readInboxState(stateFile).readAt, iso(NOW - 1000))
  // a keyed item is added once
  assert.ok(inbox.appendInbox({ kind: 'gate', text: 'x stopped', key: 'gate:x' }, { file, now: NOW }))
  assert.equal(inbox.appendInbox({ kind: 'gate', text: 'x stopped', key: 'gate:x' }, { file, now: NOW }), null)
  // a torn line is skipped
  fs.appendFileSync(file, '{"kind":"health", torn\n')
  assert.equal(inbox.readInbox(file).length, 4)
  // seen keys: new once
  assert.deepEqual(inbox.noteNew('alerts', ['a', 'b'], { stateFile }), ['a', 'b'])
  assert.deepEqual(inbox.noteNew('alerts', ['b', 'c'], { stateFile }), ['c'])
  assert.equal(inbox.readInboxState(stateFile).readAt, iso(NOW - 1000), 'the marker is kept')
})

test('the inbox keeps only its newest lines (500 in the server)', () => {
  const file = path.join(TMP, 'inbox-big', 'master-inbox.jsonl')
  // a small keep, so the test does not write 600 lines (each append is a real file write)
  for (let i = 0; i < 20; i++) inbox.appendInbox({ kind: 'alert', text: `alert ${i}` }, { file, now: NOW + i, keep: 5, trimAt: 5 })
  const all = inbox.readInbox(file)
  assert.ok(all.length <= 10, `${all.length} lines`)
  assert.equal(all.at(-1).text, 'alert 19')
  assert.equal(inbox.KEEP, 500)
})

test('a long inbox shows the newest items and says the older ones are in the parts below (the inbox has no --section)', async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ at: iso(NOW - (30 - i) * 60_000), kind: 'alert', text: `Alert number ${i} with words enough to take room on the line, again and again.` }))
  const d = await gatherDigest(providers({ inbox: () => ({ items, readAt: null }) }), { now: NOW })
  const text = renderDigest(d)
  assert.match(text, /^30 new since the inbox began/m)
  assert.match(text, /alert: Alert number 29 /, 'the newest first')
  assert.match(text, / {2}… and \d+ older: the parts below have them in full\./)
  assert.doesNotMatch(text, /--section inbox/)
  assert.ok(text.length <= DIGEST_MAX)
})
