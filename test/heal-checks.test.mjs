// Tests for the watchdog's pure checks (heal-checks.mjs, heal-reports.mjs): every check's three states from seeded
// facts, and the ONE repair each may ask for from the fixed list (none for the report-only checks).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deliveriesCheck, loopsCheck, refreshCheck, REPAIRS, storesCheck } from '../heal-checks.mjs'
import { agentsCheck, configCheck, diskCheck, serverCheck, straysCheck } from '../heal-reports.mjs'

const NOW = Date.parse('2026-11-26T12:00:00.000Z')
const MIN = 60_000
const H = 60 * MIN
const iso = ms => new Date(ms).toISOString()

// ═══ 1. the paid ticket refresh ═══

const COL = { id: 'prod', name: 'Production checklist', everyMinutes: 20, paused: false, history: [], fetchedAt: iso(NOW - 14 * 24 * H), resumedAt: null }
const paid = (n, from = NOW - 2 * H, usd = 0.031) => Array.from({ length: n }, (_, i) => ({ at: iso(from + i * 20 * MIN), kind: 'refresh', usd }))

test('refresh: ok when it works, with no timer at all, and with old spend from before its last good fetch', () => {
  assert.equal(refreshCheck({ collections: [] }).state, 'ok')
  assert.equal(refreshCheck({ collections: [{ ...COL, everyMinutes: 0 }] }).state, 'ok')
  const ok = refreshCheck({ collections: [{ ...COL, fetchedAt: iso(NOW - MIN), history: [{ at: iso(NOW - MIN), ok: true, message: '569 tickets' }] }], spend: paid(5, NOW - 5 * H) })
  assert.equal(ok.state, 'ok')
  assert.equal(ok.repair, undefined)
  assert.match(ok.text, /works \(Production checklist every 20 minutes\)/)
})

test('refresh: degraded after one or two failures in a row, with the real error', () => {
  const r = refreshCheck({ collections: [{ ...COL, fetchedAt: iso(NOW - H), history: [{ at: iso(NOW - 40 * MIN), ok: true }, { at: iso(NOW - 20 * MIN), ok: false, message: 'No dump file came back. API Error: 401 token expired' }] }], spend: paid(1, NOW - 20 * MIN) })
  assert.equal(r.state, 'degraded')
  assert.match(r.text, /failed 1 time in a row\. The last error: No dump file came back\. API Error: 401 token expired/)
  assert.equal(r.repair, undefined)
})

test('refresh: FAILING after 3 failures in a row, asking for the pause, with the cost since it last worked', () => {
  const history = [1, 2, 3].map(i => ({ at: iso(NOW - (4 - i) * 20 * MIN), ok: false, message: 'No dump file came back. exited with code 1' }))
  const r = refreshCheck({ collections: [{ ...COL, history }], spend: paid(365, NOW - 14 * 24 * H + MIN, 52.3155 / 365) })
  assert.equal(r.state, 'failing')
  assert.match(r.text, /^The ticket refresh failed 365 times and is still running every 20 minutes\. It has cost \$52\.32 since it last worked\. The last error: No dump file came back\. exited with code 1$/)
  assert.deepEqual(r.repair, { id: 'pause-refresh', target: 'prod', what: 'Paused the timer of Production checklist. It cost $52.32 since it last worked.' })
  // once paused: the brief's own sentence, and no second pause
  const p = refreshCheck({ collections: [{ ...COL, history, paused: true }], spend: paid(365, NOW - 14 * 24 * H + MIN, 52.3155 / 365) })
  assert.equal(p.state, 'failing')
  assert.match(p.text, /^The ticket refresh failed 365 times and is paused\. It has cost \$52\.32 since it last worked\./)
  assert.equal(p.repair, undefined)
})

test('refresh: after a restart (no history) 3 paid turns with no new fetch are failures too; the error says it is not known', () => {
  const r = refreshCheck({ collections: [COL], spend: paid(3) })
  assert.equal(r.state, 'failing')
  assert.match(r.text, /failed 3 times .* The last error is not known: the dashboard restarted since\./)
  assert.equal(r.repair.id, 'pause-refresh')
  // two paid turns: not yet
  assert.equal(refreshCheck({ collections: [COL], spend: paid(2) }).state, 'degraded')
})

test('refresh: after Resume the old turns are not held against it again, but the cost since it last worked still counts', () => {
  const r = refreshCheck({ collections: [{ ...COL, resumedAt: iso(NOW - 30 * MIN) }], spend: paid(10, NOW - 5 * H) })
  assert.equal(r.state, 'ok')
  const again = refreshCheck({ collections: [{ ...COL, resumedAt: iso(NOW - 70 * MIN) }], spend: paid(10, NOW - 5 * H).concat(paid(3, NOW - 60 * MIN)) })
  assert.equal(again.state, 'failing')
  assert.match(again.text, /cost \$0\.40 since it last worked/)
})

test('refresh: with two timed collections, spend names its collection and the sentence names it too', () => {
  const two = [COL, { ...COL, id: 'beta', name: 'Beta board', fetchedAt: iso(NOW - MIN) }]
  const spend = paid(3).map(l => ({ ...l, collection: 'prod' })).concat({ at: iso(NOW - 30 * MIN), kind: 'refresh', usd: 1 })
  const r = refreshCheck({ collections: two, spend })
  assert.equal(r.state, 'failing')
  assert.match(r.text, /The ticket refresh of Production checklist failed 3 times/)
  assert.equal(r.repair.target, 'prod')
  assert.equal(r.extra.collections.find(c => c.id === 'beta').state, 'ok', 'an unnamed line counts for no one when two collections run')
})

// ═══ 2. deliveries ═══

test('deliveries: ok, degraded while one waits under 30 minutes, failing past 30 minutes, held after 3 paid failures', () => {
  assert.equal(deliveriesCheck({ now: NOW }).state, 'ok')
  const w = deliveriesCheck({ waiting: [{ agent: 'QA', since: iso(NOW - 10 * MIN), items: 2 }], now: NOW })
  assert.equal(w.state, 'degraded')
  assert.match(w.text, /2 deliveries to QA wait \(10 min\): QA has no session open\. Nothing is paid while they wait/)
  assert.equal(w.repair, undefined, 'waiting for a session already runs no paid turn')
  assert.equal(deliveriesCheck({ waiting: [{ agent: 'QA', since: iso(NOW - 45 * MIN), items: 1 }], now: NOW }).state, 'failing')
  const f = deliveriesCheck({ fails: [{ agent: 'Agent 1', count: 3, lastError: 'FAILED: no such agent', held: false }], now: NOW })
  assert.equal(f.state, 'failing')
  assert.deepEqual(f.repair, { id: 'hold-deliveries', target: 'Agent 1', what: 'Held the deliveries to Agent 1 after 3 failures in a row: no paid turn runs for it until you press Release.' })
  const held = deliveriesCheck({ fails: [{ agent: 'Agent 1', count: 3, lastError: 'x', held: true, heldItems: 2 }], now: NOW })
  assert.equal(held.repair, undefined)
  assert.match(held.text, /are held: no paid turn runs for Agent 1 until you press Release/)
  assert.deepEqual(held.extra.held, [{ agent: 'Agent 1', items: 2 }])
  assert.equal(deliveriesCheck({ fails: [{ agent: 'Agent 1', count: 1, lastError: 'x' }], now: NOW }).state, 'degraded')
})

// ═══ 3. stores ═══

const STORE = name => ({ name, label: `The ${name.split('.')[0]}`, exists: true, parses: true, sig: '10:1', rebuild: null })
test('stores: ok when all read, failing for one that does not parse (copy and rebuild asked once per damaged version), degraded for a long token build', () => {
  assert.equal(storesCheck({ files: [STORE('lessons.json'), { ...STORE('suggestions.json'), exists: false }], now: NOW }).state, 'ok')
  const bad = storesCheck({ files: [{ ...STORE('token-index.json'), parses: false, error: 'Unexpected end of JSON input', rebuild: 'token' }, { ...STORE('lessons.json'), parses: false }], now: NOW })
  assert.equal(bad.state, 'failing')
  assert.match(bad.text, /The file token-index\.json \(the token-index\) does not parse: Unexpected end of JSON input\. The dashboard rebuilds it/)
  assert.match(bad.text, /The file lessons\.json \(the lessons\) does not parse\. A copy of it is kept beside it; it cannot be rebuilt/)
  assert.equal(bad.repair.id, 'copy-rebuild')
  assert.equal(bad.repair.target, 'token-index.json,lessons.json')
  const copied = storesCheck({ files: [{ ...STORE('lessons.json'), parses: false }], copied: { 'lessons.json': '10:1' }, now: NOW })
  assert.equal(copied.state, 'failing')
  assert.equal(copied.repair, undefined, 'the same damaged file is copied once')
  const slow = storesCheck({ files: [], tokenBuild: { building: true, startedAt: iso(NOW - 2 * H) }, now: NOW })
  assert.equal(slow.state, 'degraded')
  assert.match(slow.text, /The token index has been building for 2 h/)
})

// ═══ 4. loops ═══

test('loops: ok in time, degraded and restarted once after 5 times its interval, failing when still silent after the restart', () => {
  const loop = over => ({ name: 'predict', label: 'Predict and warn', everyMs: MIN, startedAt: iso(NOW - H), ...over })
  assert.equal(loopsCheck({ loops: [loop({ lastAt: iso(NOW - 2 * MIN) })], now: NOW }).state, 'ok')
  const silent = loopsCheck({ loops: [loop({ lastAt: iso(NOW - 6 * MIN) })], now: NOW })
  assert.equal(silent.state, 'degraded')
  assert.deepEqual(silent.repair, { id: 'restart-loop', target: 'predict', what: 'Started Predict and warn once more after 6 min of silence.' })
  const just = loopsCheck({ loops: [loop({ lastAt: iso(NOW - 8 * MIN), restartedAt: iso(NOW - 2 * MIN) })], now: NOW })
  assert.equal(just.state, 'degraded')
  assert.equal(just.repair, undefined, 'started once already')
  const dead = loopsCheck({ loops: [loop({ lastAt: iso(NOW - 20 * MIN), restartedAt: iso(NOW - 10 * MIN) })], now: NOW })
  assert.equal(dead.state, 'failing')
  assert.equal(dead.repair, undefined, 'never a second restart')
  assert.match(dead.text, /even after it was started once more\. Restart the dashboard\./)
  // a beat after the restart: in time again
  assert.equal(loopsCheck({ loops: [loop({ lastAt: iso(NOW - MIN), restartedAt: iso(NOW - 10 * MIN) })], now: NOW }).state, 'ok')
  // a loop that never beat counts from its start
  assert.equal(loopsCheck({ loops: [loop({ lastAt: null, startedAt: iso(NOW - 10 * MIN) })], now: NOW }).state, 'degraded')
})

test('the fixed list of repairs is exactly four, each said in a plain sentence', () => {
  assert.deepEqual(Object.keys(REPAIRS), ['pause-refresh', 'hold-deliveries', 'copy-rebuild', 'restart-loop'])
  for (const words of Object.values(REPAIRS)) assert.match(words, /^[A-Z].*\.$/)
})

// ═══ 5-9. report only ═══

test('strays: never this server; only copies older than 6 hours; degraded with their port, age and folder; no repair', () => {
  const procs = [
    { pid: 10, port: 4497, startedAt: iso(NOW - 30 * H), folder: 'C:/x/agent-dashboard/.worktrees/me' },
    { pid: 11, port: 4498, startedAt: iso(NOW - 9 * H), folder: 'C:/x/agent-dashboard/.worktrees/a' },
    { pid: 12, port: 4499, startedAt: iso(NOW - H), folder: 'C:/x/agent-dashboard/.worktrees/b' },
  ]
  const r = straysCheck({ procs, selfPid: 10, now: NOW })
  assert.equal(r.state, 'degraded')
  assert.deepEqual(r.extra.strays.map(s => s.pid), [11])
  assert.match(r.text, /1 other dashboard copy has run for more than 6 hours: port 4498, 9 h, in C:\/x\/agent-dashboard\/\.worktrees\/a\. Nothing stops it by itself/)
  assert.equal(r.repair, undefined)
  assert.equal(straysCheck({ procs: [procs[0], procs[2]], selfPid: 10, now: NOW }).state, 'ok')
  const none = straysCheck({ procs: null, error: 'powershell is missing', selfPid: 10, now: NOW })
  assert.equal(none.state, 'ok')
  assert.match(none.text, /could not be read this time: powershell is missing/)
})

test('disk: sensible, degraded past a limit with the biggest items, failing past three times it; nothing deleted', () => {
  const ok = diskCheck({ items: [{ key: 'spend', label: 'spend.jsonl', bytes: 28_000 }] })
  assert.equal(ok.state, 'ok')
  const big = diskCheck({ items: [{ key: 'evidence', label: 'The evidence folder', bytes: 2.5e9 }], biggest: [{ name: 'evidence/flow-a', bytes: 1.2e9 }] })
  assert.equal(big.state, 'degraded')
  assert.match(big.text, /The evidence folder is 2\.5 GB \(past 2\.0 GB\)\. The biggest: evidence\/flow-a 1\.2 GB\. Nothing is deleted by itself\./)
  assert.equal(diskCheck({ items: [{ key: 'spend', label: 'spend.jsonl', bytes: 16e6 }] }).state, 'failing')
  assert.equal(big.repair, undefined)
})

test('config: failing when it does not parse, degraded with every ignored setting, ok otherwise', () => {
  assert.equal(configCheck({ parses: false, error: 'Unexpected token } in JSON at position 9' }).state, 'failing')
  const w = configCheck({ warnings: ['config.json: "healing.enabled" must be true or false; true is used.'] })
  assert.equal(w.state, 'degraded')
  assert.match(w.text, /1 setting in config\.json was ignored: config\.json: "healing\.enabled"/)
  assert.equal(configCheck({}).state, 'ok')
})

test('server: a held-up event loop for 3 minutes in a row is degraded (half a second), past 2 seconds failing, with the slowest work', () => {
  const m = (p99Ms, slowest = null) => ({ p99Ms, maxMs: p99Ms, slowest })
  assert.equal(serverCheck({ minutes: [m(20), m(30)] }).state, 'ok')
  assert.equal(serverCheck({ minutes: [m(300), m(400), m(450)] }).state, 'ok', 'under half a second is fine')
  assert.equal(serverCheck({ minutes: [m(900), m(20), m(900)] }).state, 'ok', 'not sustained')
  const d = serverCheck({ minutes: [m(600), m(800, { what: 'GET /api/status', ms: 2100 }), m(550)] })
  assert.equal(d.state, 'degraded')
  assert.match(d.text, /held up to 800 ms at a time\. The slowest work: GET \/api\/status \(2\.1 s\)\./)
  assert.equal(serverCheck({ minutes: [m(2500), m(2200), m(3100)] }).state, 'failing')
})

test('agents: a busy session silent for 30 minutes and a coordinator with no session are degraded, each with a nudge to copy', () => {
  assert.equal(agentsCheck({ status: null, coordinator: 'Master', now: NOW }).state, 'ok')
  const fine = agentsCheck({ status: { agents: [{ label: 'Master', coordinator: true, status: 'busy', transcriptAt: iso(NOW - MIN) }] }, coordinator: 'Master', now: NOW })
  assert.equal(fine.state, 'ok')
  const r = agentsCheck({ status: { agents: [{ label: 'Agent 1', status: 'busy', transcriptAt: iso(NOW - 45 * MIN) }, { label: 'QA', status: 'idle', transcriptAt: iso(NOW - 5 * H) }] }, coordinator: 'Master', cli: 'C:/d/tools/factory.mjs', now: NOW })
  assert.equal(r.state, 'degraded')
  assert.match(r.text, /Agent 1 is marked busy but has written nothing for 45 min/)
  assert.match(r.text, /Master has no session open/)
  assert.deepEqual(r.extra.nudges.map(n => n.agent), ['Agent 1', 'Master'])
  assert.match(r.extra.nudges[1].text, /node C:\/d\/tools\/factory\.mjs orchestration --by "Master"/)
  assert.equal(r.repair, undefined)
})
