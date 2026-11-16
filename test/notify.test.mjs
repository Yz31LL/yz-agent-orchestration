// Tests for the rules in public/notify.js that decide which alerts one poll of
// /api/pulse raises (spec 7.4). The file is a browser script: it attaches
// window.NotifyRules first and returns before touching the DOM when there is
// no document, so it runs here in a vm context with a bare window.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const window = {}
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'notify.js'), 'utf8'), { window })
const { alerts } = window.NotifyRules
/** Objects made inside the vm have its prototypes, so strict deepEqual needs plain copies. */
const plain = v => JSON.parse(JSON.stringify(v))

const ask = (flowId, nodeId, extra = {}) => ({ flowId, flowTitle: `Flow ${flowId}`, agent: 'Agent 3', nodeId, question: `Ship ${flowId}?`, askedAt: '2026-11-12T10:00:00Z', ...extra })
const line = (id, extra = {}) => ({ id, title: `Flow ${id}`, agent: 'Agent 3', status: 'open', updatedAt: '2026-11-12T10:00:00Z', evidence: 0, undelivered: 0, ...extra })
const pulse = ({ waiting = [], flows = [] } = {}) => ({ at: 'now', waiting, flows, agents: [], chat: { busy: false } })
const run = (prev, p, opts = {}) => plain(alerts(prev, p, { seen: [], first: false, onFlows: false, ...opts }))
const types = r => r.alerts.map(a => a.type)

// ═══ waiting asks ═══

test('the open count and the keys are flowId:nodeId', () => {
  const r = run(null, pulse({ waiting: [ask('a', 'n1'), ask('b', 'n4')] }), { first: false })
  assert.equal(r.open, 2)
  assert.deepEqual(r.seen, ['a:n1', 'b:n4'])
})

test('one new ask on a later poll is one Answer alert naming the flow and node', () => {
  const r = run(new Map(), pulse({ waiting: [ask('a', 'n1')] }))
  assert.deepEqual(r.alerts, [{
    type: 'waiting', flowId: 'a', nodeId: 'n1', agent: 'Agent 3', title: 'Flow a',
    text: 'Waiting on you: Flow a', body: 'Ship a?', why: '',
  }])
})

test('an ask already seen raises nothing again, even after a reload', () => {
  const r = run(null, pulse({ waiting: [ask('a', 'n1')] }), { seen: ['a:n1'], first: true })
  assert.deepEqual(r.alerts, [{ type: 'summary', count: 1, text: '1 ask waiting for you on the Flows page.', desktop: false }])
  const later = run(new Map(), pulse({ waiting: [ask('a', 'n1')] }), { seen: ['a:n1'] })
  assert.deepEqual(later.alerts, [])
})

test('the same node id in two flows is two different asks', () => {
  const r = run(new Map(), pulse({ waiting: [ask('a', 'n1'), ask('b', 'n1')] }), { seen: ['a:n1'] })
  assert.deepEqual(r.alerts.map(a => a.flowId), ['b'])
})

test('the first poll with several new asks is one summary, with a desktop alert', () => {
  const r = run(null, pulse({ waiting: [ask('a', 'n1'), ask('b', 'n1')] }), { first: true })
  assert.deepEqual(r.alerts, [{ type: 'summary', count: 2, text: '2 asks waiting for you on the Flows page.', desktop: true }])
})

test('the first poll with exactly one new ask names it', () => {
  const r = run(null, pulse({ waiting: [ask('a', 'n1')] }), { first: true })
  assert.deepEqual(types(r), ['waiting'])
})

test('nothing waiting is a zero count and no alert', () => {
  const r = run(null, pulse(), { first: true })
  assert.equal(r.open, 0)
  assert.deepEqual(r.alerts, [])
})

test('a pulse without the waiting or flows keys never throws', () => {
  const r = plain(alerts(new Map(), { at: 'now', agents: [] }, { seen: [], first: false, onFlows: false }))
  assert.equal(r.open, 0)
  assert.deepEqual(r.alerts, [])
})

// ═══ flows ═══

const prevOf = (...lines) => new Map(lines.map(l => [l.id, l]))

test('the first poll is the baseline: a blocked or done flow raises nothing', () => {
  const r = run(null, pulse({ flows: [line('a', { status: 'blocked' }), line('b', { status: 'done', evidence: 3, undelivered: 1 })] }), { first: true })
  assert.deepEqual(r.alerts, [])
})

test('a flow turning blocked says who and what', () => {
  const r = run(prevOf(line('a')), pulse({ flows: [line('a', { status: 'blocked', agent: 'Tester', title: 'Notifier test?' })] }))
  assert.deepEqual(r.alerts, [{ type: 'blocked', flowId: 'a', agent: 'Tester', title: 'Notifier test?', text: 'Tester: Notifier test? is blocked' }])
})

test('a flow turning done says so; staying done or blocked says nothing more', () => {
  const r = run(prevOf(line('a', { status: 'blocked' })), pulse({ flows: [line('a', { status: 'done' })] }))
  assert.deepEqual(r.alerts.map(a => a.text), ['Agent 3: Flow a is done'])
  assert.deepEqual(run(prevOf(line('a', { status: 'done' })), pulse({ flows: [line('a', { status: 'done' })] })).alerts, [])
  assert.deepEqual(run(prevOf(line('a', { status: 'blocked' })), pulse({ flows: [line('a', { status: 'blocked' })] })).alerts, [])
})

test('turning open again raises nothing', () => {
  assert.deepEqual(run(prevOf(line('a', { status: 'blocked' })), pulse({ flows: [line('a')] })).alerts, [])
})

test('a flow first seen after the baseline counts from open, nothing, and no failures', () => {
  const r = run(prevOf(), pulse({ flows: [line('a', { status: 'blocked' })] }))
  assert.deepEqual(types(r), ['blocked'])
  assert.deepEqual(run(prevOf(), pulse({ flows: [line('b')] })).alerts, [])
})

test('new proof is a quiet alert away from the Flows page', () => {
  const r = run(prevOf(line('a', { evidence: 1 })), pulse({ flows: [line('a', { evidence: 2 })] }))
  assert.deepEqual(r.alerts, [{ type: 'proof', flowId: 'a', agent: 'Agent 3', title: 'Flow a', text: 'Agent 3 added proof to Flow a' }])
})

test('new proof raises nothing while the user is on the Flows page', () => {
  const r = run(prevOf(line('a', { evidence: 1 })), pulse({ flows: [line('a', { evidence: 2 })] }), { onFlows: true })
  assert.deepEqual(r.alerts, [])
})

test('proof that shrinks (a rewritten flow) raises nothing', () => {
  assert.deepEqual(run(prevOf(line('a', { evidence: 3 })), pulse({ flows: [line('a', { evidence: 1 })] })).alerts, [])
})

test('a failed delivery raises a retry alert, on any view', () => {
  for (const onFlows of [false, true]) {
    const r = run(prevOf(line('a')), pulse({ flows: [line('a', { undelivered: 1 })] }), { onFlows })
    assert.deepEqual(r.alerts, [{ type: 'undelivered', flowId: 'a', agent: 'Agent 3', title: 'Flow a', text: 'Agent 3: an answer could not be delivered' }])
  }
})

test('a failure that is fixed, or one already reported, raises nothing', () => {
  assert.deepEqual(run(prevOf(line('a', { undelivered: 1 })), pulse({ flows: [line('a')] })).alerts, [])
  assert.deepEqual(run(prevOf(line('a', { undelivered: 1 })), pulse({ flows: [line('a', { undelivered: 1 })] })).alerts, [])
})

test('the flows returned are the next baseline, by id', () => {
  const r = alerts(null, pulse({ flows: [line('a', { evidence: 2 })] }), { seen: [], first: true, onFlows: false })
  assert.equal(r.flows.get('a').evidence, 2)
  const next = plain(alerts(r.flows, pulse({ flows: [line('a', { evidence: 3, status: 'done' })] }), { seen: [], first: false, onFlows: false }))
  assert.deepEqual(types(next), ['done', 'proof'])
})

test('waiting asks come before flow alerts', () => {
  const r = run(prevOf(line('a')), pulse({ waiting: [ask('a', 'n1')], flows: [line('a', { status: 'blocked' })] }))
  assert.deepEqual(types(r), ['waiting', 'blocked'])
})

// ═══ retry: the Retry button on an undelivered toast really delivers again ═══

/** A fetch stub: GET of the flow returns `flow`, each POST answers from `posts` in order; every call is logged. */
function stubFetch(flow, posts = [], { getStatus = 200 } = {}) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers, body: init.body })
    if (!init.method) return { ok: getStatus === 200, status: getStatus, json: async () => (getStatus === 200 ? flow : { error: 'no such flow' }) }
    const next = posts.shift()
    if (next instanceof Error) throw next
    return { ok: next.status === 200, status: next.status, json: async () => next.body }
  }
  return { fetch, calls }
}
const askNode = (id, extra = {}) => ({ id, type: 'ask', title: `Q ${id}`, answer: 'yes', ...extra })
const failedFlow = (...nodes) => ({ id: 'my flow', nodes })
const { retryDelivery } = window.NotifyRules

test('retry reads the flow, then POSTs deliver for the failed ask, same-origin JSON', async () => {
  const s = stubFetch(failedFlow(askNode('n1'), askNode('n3', { deliveryError: 'Agent 3 is not running' })), [{ status: 200, body: { ok: true } }])
  const r = plain(await retryDelivery('my flow', s.fetch))
  assert.deepEqual(r, { found: 1, sent: 1, errors: [] })
  assert.deepEqual(plain(s.calls), [
    { url: '/api/flows/my%20flow', method: 'GET' },
    { url: '/api/flows/my%20flow/deliver', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"node":"n3"}' },
  ])
})

test('retry delivers every failed ask in the flow, one after another', async () => {
  const s = stubFetch(failedFlow(askNode('n1', { deliveryError: 'x' }), { id: 'n2', type: 'step', deliveryError: 'not an ask' }, askNode('n4', { deliveryError: 'y' })),
    [{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true } }])
  const r = plain(await retryDelivery('f', s.fetch))
  assert.deepEqual(r, { found: 2, sent: 2, errors: [] })
  assert.deepEqual(s.calls.slice(1).map(c => c.body), ['{"node":"n1"}', '{"node":"n4"}'])
})

test('a delivery that fails again comes back with the relay error', async () => {
  const s = stubFetch(failedFlow(askNode('n1', { deliveryError: 'old' })), [{ status: 200, body: { ok: false, error: 'No agent named Agent 3' } }])
  assert.deepEqual(plain(await retryDelivery('f', s.fetch)), { found: 1, sent: 0, errors: [{ nodeId: 'n1', error: 'No agent named Agent 3' }] })
})

test('a refused POST or a network failure is an error, never a throw', async () => {
  const refused = stubFetch(failedFlow(askNode('n1', { deliveryError: 'old' })), [{ status: 403, body: { error: 'same-origin only' } }])
  assert.deepEqual(plain(await retryDelivery('f', refused.fetch)).errors, [{ nodeId: 'n1', error: 'same-origin only' }])
  const silent = stubFetch(failedFlow(askNode('n1', { deliveryError: 'old' })), [{ status: 500, body: {} }])
  assert.deepEqual(plain(await retryDelivery('f', silent.fetch)).errors, [{ nodeId: 'n1', error: 'Failed (500)' }])
  const down = stubFetch(failedFlow(askNode('n1', { deliveryError: 'old' })), [new Error('Failed to fetch')])
  assert.deepEqual(plain(await retryDelivery('f', down.fetch)).errors, [{ nodeId: 'n1', error: 'Failed to fetch' }])
})

test('nothing left to deliver posts nothing', async () => {
  const s = stubFetch(failedFlow(askNode('n1', { sentAt: '2026-11-12T10:00:00Z' })))
  assert.deepEqual(plain(await retryDelivery('f', s.fetch)), { found: 0, sent: 0, errors: [] })
  assert.equal(s.calls.length, 1)
})

test('a flow that cannot be read posts nothing and says why', async () => {
  const s = stubFetch(null, [], { getStatus: 404 })
  assert.deepEqual(plain(await retryDelivery('gone', s.fetch)), { found: 0, sent: 0, errors: [{ nodeId: null, error: 'no such flow' }] })
  assert.equal(s.calls.length, 1)
})

// ═══ where the count shows (spec 5): the bell and the header dot, no rail badge ═══

test('the open-ask count shows on the bell only: no badge on a rail item', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'public', 'notify.js'), 'utf8')
  assert.doesNotMatch(src, /tab-badge|#rail a\[data-view/)
  assert.match(src, /nt-count/)
  for (const css of ['shell.css', 'orchestration.css']) {
    assert.doesNotMatch(fs.readFileSync(path.join(HERE, '..', 'public', css), 'utf8'), /\.tab-badge/, `${css} keeps no dead .tab-badge rule`)
  }
})

// ═══ the alert history behind the rail bell (spec 5): alerts.history, newest first, 50 at most ═══

const { history, loadHistory, saveHistory } = window.NotifyRules
const entry = i => ({ at: `2026-11-12T10:${String(i % 60).padStart(2, '0')}:00Z`, html: `<b>alert ${i}</b>`, action: { label: 'Open', kind: 'open', flowId: `f${i}` } })

test('history puts the newest entry first and keeps the rest in order', () => {
  const r = plain(history([entry(2), entry(1)], entry(3)))
  assert.deepEqual(r.map(e => e.html), ['<b>alert 3</b>', '<b>alert 2</b>', '<b>alert 1</b>'])
})

test('history caps at 50 by default, dropping the oldest', () => {
  let list = []
  for (let i = 1; i <= 51; i++) list = history(list, entry(i))
  assert.equal(list.length, 50)
  assert.equal(list[0].html, '<b>alert 51</b>')
  assert.equal(list[49].html, '<b>alert 2</b>', 'the first of 51 is the one dropped')
  assert.equal(history(list, entry(52), 3).length, 3, 'a smaller cap is honoured')
})

test('history never mutates the list it was given', () => {
  const list = [entry(1), entry(2)]
  const before = plain(list)
  const r = history(list, entry(3))
  assert.notEqual(r, list)
  assert.deepEqual(plain(list), before)
})

test('a history that is not an array counts as empty', () => {
  for (const bad of [null, undefined, '[]', { 0: entry(1) }, 7]) {
    assert.deepEqual(plain(history(bad, entry(1))).map(e => e.html), ['<b>alert 1</b>'])
  }
})

/** A Storage double: a Map, or one whose every call throws (private mode, blocked site data). */
const memoryStorage = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m }
}
const throwingStorage = () => ({ getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('QuotaExceededError') }, removeItem() { throw new Error('SecurityError') } })

test('the history is kept under the key alerts.history exactly, as JSON', () => {
  const s = memoryStorage()
  assert.equal(saveHistory(() => s, [entry(1)]), true)
  assert.deepEqual([...s.map.keys()], ['alerts.history'])
  assert.deepEqual(plain(loadHistory(() => s)), [plain(entry(1))])
})

test('a localStorage that throws reads as an empty history and a save that fails never throws', () => {
  assert.deepEqual(plain(loadHistory(() => throwingStorage())), [])
  assert.equal(saveHistory(() => throwingStorage(), [entry(1)]), false)
  // reaching window.localStorage can itself throw (a sandboxed frame): still empty, still no throw
  const blocked = () => { throw new Error('SecurityError: access denied') }
  assert.deepEqual(plain(loadHistory(blocked)), [])
  assert.equal(saveHistory(blocked, []), false)
})

test('a stored history that is missing, corrupt or not a list reads as empty; odd entries are dropped', () => {
  assert.deepEqual(plain(loadHistory(() => memoryStorage())), [])
  assert.deepEqual(plain(loadHistory(() => memoryStorage({ 'alerts.history': '{not json' }))), [])
  assert.deepEqual(plain(loadHistory(() => memoryStorage({ 'alerts.history': '{"html":"x"}' }))), [])
  const mixed = JSON.stringify([entry(1), null, 'x', { at: 'now' }, entry(2)])
  assert.deepEqual(plain(loadHistory(() => memoryStorage({ 'alerts.history': mixed }))).map(e => e.html), ['<b>alert 1</b>', '<b>alert 2</b>'])
})

test('a stored history longer than 50 reads back as the newest 50', () => {
  const long = Array.from({ length: 60 }, (_, i) => entry(i))
  assert.equal(loadHistory(() => memoryStorage({ 'alerts.history': JSON.stringify(long) })).length, 50)
})

test('a history row tells its time through Shell.ago (spec 6), and the per-load summary stays out of the history', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'public', 'notify.js'), 'utf8')
  assert.match(src, /<time[^`]*\$\{window\.Shell\.ago\(e\.at\)\}<\/time>/)
  assert.match(src, /case 'summary': \{\r?\n[^\n]*\n\s*toast\([^\n]*keep: false/, 'the summary toast is not kept')
  assert.match(src, /if \(keep\) \{\s*saveHistory\(/, 'only kept toasts are saved')
})

test('every toast is recorded with a serialisable action, and the panel re-creates its run from kind', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'public', 'notify.js'), 'utf8')
  assert.doesNotMatch(src, /run:\s/, 'no toast action carries a closure: toast derives run from kind')
  for (const kind of ['answer', 'open', 'retry', 'tickets', 'drawer']) assert.match(src, new RegExp(`case '${kind}'`), `runAction handles ${kind}`)
  assert.match(src, /saveHistory\(/)
})

test('opening the panel folds a hover-opened rail, so the panel sits beside the 56 px rail', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'public', 'notify.js'), 'utf8')
  assert.match(src, /function openPanel\(\) \{[^}]*Shell\?\.collapseRail\?\.\(\)/)
})

// ═══ Escape ═══

test('Escape closes the alerts panel only when it is open, nothing took the key, and the palette is shut', () => {
  const { takesEscape } = window.NotifyRules
  const esc = (more = {}) => ({ key: 'Escape', defaultPrevented: false, ...more })
  assert.equal(takesEscape(esc(), true, {}), true)
  assert.equal(takesEscape(esc(), false, {}), false, 'a closed panel')
  assert.equal(takesEscape(esc({ key: 'Enter' }), true, {}), false, 'another key')
  assert.equal(takesEscape(esc({ defaultPrevented: true }), true, {}), false, 'something on top took it')
  assert.equal(takesEscape(esc(), true, { Palette: { isOpen: true } }), false, 'the command palette is open: it closes first')
  assert.equal(takesEscape(esc(), true, { Palette: { isOpen: false } }), true)
})

test('on the Flows page the first poll raises no N asks waiting summary: the header dot and the strip already say it', () => {
  const several = pulse({ waiting: [ask('a', 'n1'), ask('b', 'n1')] })
  assert.deepEqual(types(run(null, several, { first: true, onFlows: true })), [])
  assert.deepEqual(run(null, several, { first: true, onFlows: true }).seen, ['a:n1', 'b:n1'], 'still seen, so they never pop later')
  assert.deepEqual(types(run(null, several, { first: true, onFlows: false })), ['summary'], 'other pages keep it')
})
