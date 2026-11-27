// Tests for phone-actions.mjs: the FIXED list of what a phone session may do, each mapped to the server function
// the desktop uses (flows.mjs applyAnswer then relay.queue; human-routes.mjs handTickRoute; completed-routes.mjs
// completeRoute; phone-talk.mjs), and NOT more: no second answer, no reopen, no uncomplete, no tick of another
// flow's step, no unfinished flow completed. FACTORY_DATA_DIR points at a temp folder BEFORE the imports.

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-actions-test-'))
const F = await import('../flows.mjs')
const { makePhoneActions, ACTIONS } = await import('../phone-actions.mjs')

const DAY = 86_400_000
const file = id => path.join(F.FLOWS_DIR, `${id}.json`)
const ago = d => new Date(Date.now() - d * DAY).toISOString()
function put(id, more = {}) {
  const flow = {
    id, title: `Flow ${id}`, agent: 'Agent 1', tickets: [], status: 'open', why: '', createdAt: ago(2), updatedAt: ago(1),
    nodes: [{ id: 'n1', type: 'step', title: 'Look into it', status: 'done', evidence: [], verified: null }], ...more,
  }
  fs.writeFileSync(file(id), JSON.stringify(flow, null, 1))
}
const ask = (id, kind = 'yesno', answer = null) => ({ id, type: 'ask', title: `Ship ${id}?`, why: 'Because it is ready.', kind, yes: 'ship it', no: 'hold it', answer, at: ago(0.5) })
const STEP = { id: 'h1', do: 'Add the deploy secret', where: 'GitHub › Settings › Secrets', copy: 'FIREBASE_TOKEN', expect: 'It is listed', at: ago(0.5), done: null }

let calls
let relay
const talk = { send: async (t, sid) => ({ status: 202, body: { ok: true, text: t, sid } }), threadWithReplies: async (...a) => ({ label: 'Master', messages: [], busy: false, running: true, args: a.length }) }
const agents = [{ label: 'Agent 1', state: 'active', status: 'busy' }, { label: 'QA', state: 'idle', status: 'idle' }]
const actions = () => makePhoneActions({ relay, talk, getStatus: async () => ({ agents }), cost: () => 'Each message costs about 14 cents.' })

beforeEach(() => {
  calls = []
  relay = new Proxy({}, { get: (_, name) => (...a) => calls.push([name, ...a]) })
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
})

test('the allowlist is exactly: read the summary, the orchestration, a flow sheet and a pull request, answer, tick, complete, and talk to the coordinator', () => {
  assert.deepEqual([...ACTIONS].sort(), ['answer', 'complete', 'flow', 'orchestration', 'pr', 'summary', 'talk', 'talkSend', 'tick'])
  assert.deepEqual(Object.keys(actions()).sort(), [...ACTIONS].sort())
})

test('a pull request is read through the reader it is given (phone-pr.mjs), and with none every one is a 404', async () => {
  const seen = []
  const reader = { read: async b => (seen.push(b), { status: 200, body: { title: 'Login' } }) }
  const r = await makePhoneActions({ relay, talk, getStatus: async () => ({ agents }), prReader: reader }).pr({ flow: 'login', n: null, keys: ['flow'] })
  assert.deepEqual(r, { status: 200, body: { title: 'Login' } })
  assert.deepEqual(seen, [{ flow: 'login', n: null, keys: ['flow'] }])
  const none = await actions().pr({ flow: 'login', keys: ['flow'] })
  assert.equal(none.status, 404)
})

test('the wiring builds the reader on the desktop Pull requests list and server.mjs gh, and nothing else', () => {
  const wiring = fs.readFileSync(new URL('../phone-wiring.mjs', import.meta.url), 'utf8')
  assert.match(wiring, /makePrReader\(\{ gh, prs \}\)/)
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(server, /startPhone\(\{[^}]*\bgh,/, 'the same gh runner as the Pull requests list, FACTORY_TEST_GH included')
})

// ═══ the summary ═══

test('the summary: what needs the user, and the questions, by-hand steps and outputs; no agent lines (the Agents tab has them)', async () => {
  put('asker', { nodes: [ask('a1'), ask('a2', 'text')] })
  put('hands', { agent: 'Agent 2', hand: { steps: [STEP] } })
  put('shipped', { status: 'done', output: { summary: 'Done.', story: [{ id: 's1', who: 'Agent 1', did: 'Built the login page.', why: 'You asked.' }] } })
  put('dropped', { status: 'dropped', nodes: [ask('x1')] })
  const { status, body } = await actions().summary()
  assert.equal(status, 200)
  assert.deepEqual(body.needs, { total: 4, asks: 2, hands: 1, outputs: 1 })
  assert.equal('agents' in body, false)
  assert.equal(body.finishedToday, 0, 'shipped finished a day ago')
  const a = body.asks.find(x => x.nodeId === 'a1')
  assert.deepEqual({ flowId: a.flowId, question: a.question, why: a.why, kind: a.kind, yes: a.yes, no: a.no }, { flowId: 'asker', question: 'Ship a1?', why: 'Because it is ready.', kind: 'yesno', yes: 'ship it', no: 'hold it' })
  assert.equal(body.asks.find(x => x.nodeId === 'a2').kind, 'text')
  assert.deepEqual(body.hands[0].steps.map(s => [s.id, s.do, s.done]), [['h1', 'Add the deploy secret', false]])
  assert.deepEqual(body.outputs.map(o => [o.flowId, o.story.map(l => l.did)]), [['shipped', ['Built the login page.']]])
  assert.match(body.costNote, /few cents/)
})

test('finished today counts flows finished since local midnight', async () => {
  put('today', { status: 'done', updatedAt: new Date().toISOString() })
  put('old', { status: 'done', updatedAt: ago(3) })
  assert.equal((await actions().summary()).body.finishedToday, 1)
})

test('the summary never waits for the status build: it answers at once even when the agents never come', async () => {
  put('asker', { nodes: [ask('a1')] })
  const started = Date.now()
  const r = await makePhoneActions({ relay, talk, getStatus: () => new Promise(() => {}) }).summary()
  assert.ok(Date.now() - started < 1000)
  assert.equal(r.body.needs.asks, 1)
})

// ═══ answer ═══

test('answer: the same store function as the desktop, then ONE relay.queue for that node, and nothing else', async () => {
  put('asker', { nodes: [ask('a1'), ask('t1', 'text')] })
  const r = await actions().answer({ flowId: 'asker', nodeId: 'a1', answer: 'yes' })
  assert.equal(r.status, 200)
  const node = F.readFlow('asker').nodes.find(n => n.id === 'a1')
  assert.equal(node.answer, 'yes')
  assert.ok(node.answeredAt)
  assert.deepEqual(calls, [['queue', 'asker', 'a1']])
  await actions().answer({ flowId: 'asker', nodeId: 't1', answer: '  Use the blue one.  ' })
  assert.equal(F.readFlow('asker').nodes.find(n => n.id === 't1').answer, 'Use the blue one.')
})

test('answer twice is refused: the phone never changes or reopens an answer', async () => {
  put('asker', { nodes: [ask('a1', 'yesno', 'no')] })
  const r = await actions().answer({ flowId: 'asker', nodeId: 'a1', answer: 'yes' })
  assert.equal(r.status, 409)
  assert.match(r.body.error, /already has an answer/)
  assert.equal(F.readFlow('asker').nodes[0].answer, 'no')
  put('open', { nodes: [ask('a1')] })
  assert.equal((await actions().answer({ flowId: 'open', nodeId: 'a1', answer: null })).status, 400, 'null (reopen) is not an answer here')
  assert.deepEqual(calls, [])
})

test('answer refuses in plain words: a bad answer, a step that is no question, unknown ids, a finished or dropped flow', async () => {
  put('asker', { nodes: [ask('a1'), ask('t1', 'text'), { id: 'n1', type: 'step', title: 'x', status: 'todo', evidence: [], verified: null }] })
  put('closed', { status: 'done', nodes: [ask('a1')] })
  put('dropped', { status: 'dropped', nodes: [ask('a1')] })
  put('away', { archivedAt: ago(0.1), nodes: [ask('a1')] })
  const cases = [
    [{ flowId: 'asker', nodeId: 'a1', answer: 'maybe' }, 400],
    [{ flowId: 'asker', nodeId: 't1', answer: '   ' }, 400],
    [{ flowId: 'asker', nodeId: 't1', answer: 'x'.repeat(2001) }, 400],
    [{ flowId: 'asker', nodeId: 'a1', answer: 42 }, 400],
    [{ flowId: 'asker', nodeId: 'n1', answer: 'yes' }, 400],
    [{ flowId: 'asker', nodeId: 'zz', answer: 'yes' }, 404],
    [{ flowId: 'nope', nodeId: 'a1', answer: 'yes' }, 404],
    [{ flowId: '../etc', nodeId: 'a1', answer: 'yes' }, 400],
    [{ flowId: 'asker', nodeId: '../x', answer: 'yes' }, 400],
    [{ flowId: 'closed', nodeId: 'a1', answer: 'yes' }, 409],
    [{ flowId: 'dropped', nodeId: 'a1', answer: 'yes' }, 409],
    [{ flowId: 'away', nodeId: 'a1', answer: 'yes' }, 409],
    [null, 400],
  ]
  for (const [b, want] of cases) {
    const r = await actions().answer(b)
    assert.equal(r.status, want, JSON.stringify(b))
    assert.equal(typeof r.body.error, 'string')
  }
  assert.deepEqual(calls, [])
  assert.equal(F.readFlow('asker').nodes[0].answer, null)
})

// ═══ tick ═══

test('tick: the desktop tick (handTickRoute) on that flow only; a step of another flow is refused', async () => {
  put('hands', { hand: { steps: [STEP] } })
  put('other', { hand: { steps: [{ ...STEP, id: 'h2' }] } })
  const r = await actions().tick({ flowId: 'hands', step: 'h1', done: true })
  assert.equal(r.status, 200)
  assert.equal(F.readFlow('hands').hand.steps[0].done.by, 'you')
  const wrong = await actions().tick({ flowId: 'hands', step: 'h2', done: true })
  assert.equal(wrong.status, 400)
  assert.equal(F.readFlow('other').hand.steps[0].done, null)
  assert.equal((await actions().tick({ flowId: 'hands', step: 'h1', done: 'yes' })).status, 400)
  assert.equal((await actions().tick({ flowId: 'hands', step: 'h1', done: false })).status, 200, 'untick, as on the desktop')
  assert.deepEqual(calls, [], 'a tick tells no agent, as on the desktop')
})

test('tick refuses a finished, dropped or archived flow', async () => {
  for (const [id, more] of [['done1', { status: 'done' }], ['drop1', { status: 'dropped' }], ['arch1', { archivedAt: ago(0.1) }]]) {
    put(id, { hand: { steps: [STEP] }, ...more })
    assert.equal((await actions().tick({ flowId: id, step: 'h1', done: true })).status, 409, id)
    assert.equal(F.readFlow(id).hand.steps[0].done, null)
  }
})

// ═══ complete ═══

test('complete: a finished flow is marked completed by you, through completeRoute; never uncompleted from the phone', async () => {
  put('shipped', { status: 'done' })
  const r = await actions().complete({ flowId: 'shipped' })
  assert.equal(r.status, 200)
  const f = F.readFlow('shipped')
  assert.equal(f.completedBy, 'you')
  assert.ok(f.completedAt)
  const undo = await actions().complete({ flowId: 'shipped', completed: false })
  assert.equal(undo.status, 400)
  assert.ok(F.readFlow('shipped').completedAt, 'still completed')
})

test('complete refuses an unfinished flow with the desktop sentence, and writes nothing', async () => {
  put('busy')
  const before = fs.readFileSync(file('busy'), 'utf8')
  const r = await actions().complete({ flowId: 'busy' })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /Only a finished flow can be marked completed/)
  assert.equal(fs.readFileSync(file('busy'), 'utf8'), before)
  assert.equal((await actions().complete({ flowId: 'nope' })).status, 404)
  assert.equal((await actions().complete({ flowId: 'a/b' })).status, 400)
})

// ═══ the orchestration (phone-orchestration.mjs, tested on its own) ═══

test('orchestration and flow are the read-only builders, with the alerts passed through', async () => {
  let asked = 0
  const a = makePhoneActions({ relay, talk, getStatus: async () => ({ agents }), alerts: async () => (asked++, { status: 200, body: { enabled: true, alerts: [{ text: 'One.' }] } }) })
  const o = await a.orchestration()
  assert.equal(o.status, 200)
  assert.equal(asked, 1)
  assert.deepEqual(o.body.alerts, { count: 1, kinds: '', lines: ['One.'] })
  put('seen', { title: 'Seen flow' })
  assert.equal((await a.flow({ id: 'seen' })).body.title, 'Seen flow')
  assert.equal((await a.flow({ id: '../x' })).status, 400)
  assert.deepEqual(calls, [], 'nothing relayed, nothing written')
})

test('the Pull requests list is passed through to the orchestration (one list for the desktop and the phone)', async () => {
  const prs = () => [{ url: 'https://github.com/o/r/pull/9', number: 9, title: 'Nine' }]
  const o = await makePhoneActions({ relay, talk, getStatus: async () => ({ agents }), prs }).orchestration()
  assert.deepEqual(o.body.prs, [{ title: 'Nine', url: 'https://github.com/o/r/pull/9', number: 9, flow: null }])
  assert.deepEqual((await makePhoneActions({ relay, talk, getStatus: async () => ({ agents }) }).orchestration()).body.prs, [])
})

// ═══ talk ═══

test('talk reads the one thread with its cost line, and sends through phone-talk.mjs, the text as given', async () => {
  const a = actions()
  const th = (await a.talk({}, { session: 'abc' })).body
  assert.equal(th.args, 0, 'the same thread for every phone session: no session is passed')
  assert.equal(th.cost, 'Each message costs about 14 cents.')
  const r = await a.talkSend({ text: 'hello' }, { session: 'abc' })
  assert.equal(r.status, 202)
  assert.equal(r.body.text, 'hello')
  assert.equal(r.body.sid, 'abc')
})

