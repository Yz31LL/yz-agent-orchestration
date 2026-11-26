// Tests for the watchdog's runner (heal-runner.mjs) with its repairs (heal-repairs.mjs) and disk facts
// (heal-facts.mjs): the refresh paused after 3 failures with its cost, and nothing more spent; deliveries with no
// session never retried; a damaged store kept and rebuilt; a silent loop restarted ONCE; stray servers listed and
// never stopped; the repairs switch (report only) and the per-check switch; the inbox and the urgent path; and
// config.json never written. Temp folders and stubs only: no model, no process is looked at or stopped.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-runner-test-'))
process.env.FACTORY_DATA_DIR = TMP
const { makeHealRunner, CHECK_IDS } = await import('../heal-runner.mjs')
const { makeRepairs } = await import('../heal-repairs.mjs')
const { configFacts, diskFacts, storeFacts } = await import('../heal-facts.mjs')
const { readHealLog, readHealState } = await import('../heal-store.mjs')
const { makeBeats } = await import('../heal-beats.mjs')
const { healingSettings } = await import('../insight-settings.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json')
const configBefore = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null
const NOW = Date.parse('2026-11-26T12:00:00.000Z')
const MIN = 60_000
const iso = ms => new Date(ms).toISOString()
let k = 0
const dir = () => fs.mkdtempSync(path.join(TMP, `r${k++}-`))

/** A runner over one folder, with only the facts given; everything else says ok. */
function runner(facts, { repairs = true, enabled = true, actions = {}, inbox, clock } = {}) {
  const d = dir()
  const items = []
  const notes = []
  const t = clock || { now: NOW }
  const r = makeHealRunner({
    settings: () => ({ enabled, repairs }), facts, actions, now: () => t.now,
    stateFile: path.join(d, 'heal-state.json'), logFile: path.join(d, 'heal-log.jsonl'), log: () => {},
    inbox: inbox || { append: i => items.push(i), notify: n => notes.push(n) },
  })
  return { r, d, items, notes, t, log: () => readHealLog(path.join(d, 'heal-log.jsonl')), state: () => readHealState(path.join(d, 'heal-state.json')) }
}
const one = (view, id) => view.checks.find(c => c.id === id)

// ═══ the paid ticket refresh ═══

function refreshWorld() {
  const world = { paused: false, spent: 0, turns: 0 }
  const fails = [1, 2, 3].map(i => ({ at: iso(NOW - (4 - i) * 20 * MIN), ok: false, message: 'No dump file came back. API Error: 401 token expired' }))
  const spend = Array.from({ length: 30 }, (_, i) => ({ at: iso(NOW - 10 * 3_600_000 + i * 20 * MIN), kind: 'refresh', usd: 0.0312, collection: 'prod' }))
  const facts = { refresh: async () => ({ collections: [{ id: 'prod', name: 'Production checklist', everyMinutes: 20, paused: world.paused, history: fails, fetchedAt: iso(NOW - 3 * 86_400_000), resumedAt: null }], spend }) }
  const sources = { pause: id => (id === 'prod' && !world.paused ? (world.paused = true) : false) }
  return { world, facts, sources }
}

test('refresh: after 3 failures the timer is paused, the repair is logged with the cost, the page says the brief sentence and the real error', async () => {
  const { world, facts, sources } = refreshWorld()
  const h = runner(facts, { actions: makeRepairs({ sources }) })
  await h.r.runOnce()
  assert.equal(world.paused, true)
  const c = one(h.r.view(), 'refresh')
  assert.equal(c.state, 'failing')
  assert.match(c.text, /^The ticket refresh failed 30 times and is paused\. It has cost \$0\.94 since it last worked\. The last error: No dump file came back\. API Error: 401 token expired$/)
  assert.equal(c.lastRepair.did, 'Paused the timer of Production checklist. It cost $0.94 since it last worked.')
  const log = h.log()
  assert.equal(log.length, 1)
  assert.equal(log[0].check, 'refresh')
  assert.equal(log[0].result, 'done')
  assert.match(log[0].saw, /prod: 30 failed, \$0\.94 since it last worked, running/)
  assert.deepEqual(h.items.map(i => i.kind), ['repair', 'health'])
  assert.equal(h.notes.length, 1)
  assert.equal(h.notes[0].urgent, true)
  // the next pass pauses nothing more and logs nothing more
  h.t.now += MIN
  await h.r.runOnce()
  assert.equal(h.log().length, 1)
  assert.equal(h.items.length, 2, 'no new item while nothing changed')
})

test('the repairs switch off: the watchdog only reports, writes the repair ONCE as would, and pauses nothing', async () => {
  const { world, facts, sources } = refreshWorld()
  const h = runner(facts, { repairs: false, actions: makeRepairs({ sources }) })
  await h.r.runOnce()
  h.t.now += MIN
  await h.r.runOnce()
  assert.equal(world.paused, false)
  const log = h.log()
  assert.equal(log.length, 1)
  assert.equal(log[0].result, 'would')
  assert.match(log[0].did, /^Would have done: Paused the timer .* Repairs are off/)
  const c = one(h.r.view(), 'refresh')
  assert.match(c.text, /still running every 20 minutes/)
  assert.match(c.would, /Pause the timer of a failing paid ticket refresh/)
  assert.equal(c.lastRepair, null, 'a would line is not a repair')
  assert.deepEqual(h.r.view().repairs24h, [])
})

test('the per-check switch: a check switched off is not run and repairs nothing; on again, it runs', async () => {
  const { world, facts, sources } = refreshWorld()
  const h = runner(facts, { actions: makeRepairs({ sources }) })
  assert.equal(h.r.setSwitch('refresh', false), true)
  assert.equal(h.r.setSwitch('nonsense', false), false)
  await h.r.runOnce()
  assert.equal(world.paused, false)
  assert.equal(one(h.r.view(), 'refresh').state, 'off')
  assert.equal(one(h.r.view(), 'refresh').on, false)
  assert.deepEqual(h.state().off, { refresh: true })
  h.r.setSwitch('refresh', true)
  h.t.now += MIN
  await h.r.runOnce()
  assert.equal(world.paused, true)
})

test('healing.enabled false: nothing runs, every check says the watchdog is off', async () => {
  let looked = 0
  const h = runner({ refresh: async () => (looked++, { collections: [] }) }, { enabled: false })
  await h.r.runOnce()
  assert.equal(looked, 0)
  assert.ok(h.r.view().checks.every(c => c.state === 'off'))
  assert.equal(h.r.view().enabled, false)
  assert.deepEqual(healingSettings({ enabled: false }), { enabled: false, repairs: true })
})

// ═══ deliveries: no session means no retry and no paid turn ═══

test('deliveries waiting for a session: reported with the agent, no repair, no turn; 3 paid failures: held', async () => {
  const relay = { holds: [], hold(a) { this.holds.push(a); return true } }
  let health = { waiting: [{ agent: 'QA', since: iso(NOW - 45 * MIN), items: 2 }], fails: [] }
  const h = runner({ deliveries: async () => health }, { actions: makeRepairs({ relay }) })
  await h.r.runOnce()
  const c = one(h.r.view(), 'deliveries')
  assert.equal(c.state, 'failing')
  assert.match(c.text, /QA has no session open\. Nothing is paid while they wait/)
  assert.deepEqual(relay.holds, [], 'waiting for a session is never retried with a paid turn, and nothing is held')
  health = { waiting: [], fails: [{ agent: 'Agent 1', count: 3, lastError: 'FAILED: x', held: false }] }
  h.t.now += MIN
  await h.r.runOnce()
  assert.deepEqual(relay.holds, ['Agent 1'])
  assert.equal(h.log().at(-1).did, 'Held the deliveries to Agent 1 after 3 failures in a row: no paid turn runs for it until you press Release.')
})

// ═══ a damaged store: kept and rebuilt ═══

test('a damaged store is kept beside it and rebuilt where the code can; one it cannot rebuild is copied once and reported', async () => {
  const d = dir()
  const standup = path.join(d, 'standup-index.json')
  const lessons = path.join(d, 'lessons.json')
  fs.writeFileSync(standup, '{"days": torn')
  fs.writeFileSync(lessons, '{"lessons": [ torn')
  const stores = [
    { name: 'standup/index.json', label: 'The stand-up index', file: standup, rebuild: 'standup' },
    { name: 'lessons.json', label: 'The lessons', file: lessons, rebuild: null },
  ]
  const rebuilt = []
  const cache = new Map()
  const stateFile = path.join(d, 'heal-state.json')
  const repairs = makeRepairs({ stores, rebuild: { standup: async () => (rebuilt.push('standup'), fs.writeFileSync(standup, '{"days":{}}')) }, stateFile })
  // the runner and the repairs share one state file, as in the server
  const r = makeHealRunner({ settings: () => ({ enabled: true, repairs: true }), facts: { stores: async () => ({ files: await storeFacts(stores, cache) }) }, actions: repairs, now: () => NOW, stateFile, logFile: path.join(d, 'heal-log.jsonl'), log: () => {} })
  await r.runOnce()
  assert.deepEqual(rebuilt, ['standup'])
  const files = fs.readdirSync(d).filter(f => f !== 'heal-state.json' && f !== 'heal-log.jsonl').sort()
  assert.equal(files.filter(f => f.startsWith('standup-index.json.damaged-')).length, 1, 'the damaged index was moved aside')
  assert.equal(fs.readFileSync(path.join(d, files.find(f => f.startsWith('standup-index.json.damaged-'))), 'utf8'), '{"days": torn')
  assert.equal(fs.readFileSync(standup, 'utf8'), '{"days":{}}', 'rebuilt')
  assert.equal(files.filter(f => f.startsWith('lessons.json.damaged-')).length, 1, 'a copy of the lessons kept')
  assert.equal(fs.readFileSync(lessons, 'utf8'), '{"lessons": [ torn', 'the lessons file itself is left for the user')
  const c = r.view().checks.find(x => x.id === 'stores')
  assert.equal(c.state, 'failing', 'the lessons still do not parse')
  assert.match(c.lastRepair.did, /^Kept the damaged stand-up index as standup-index\.json\.damaged-\d{8}-\d{6} and rebuilt it from its sources\. Kept a copy of the damaged lessons as lessons\.json\.damaged-\d{8}-\d{6}\. It cannot be rebuilt/)
  // the next pass copies nothing again
  await r.runOnce()
  assert.equal(fs.readdirSync(d).filter(f => f.includes('.damaged-')).length, 2)
})

// ═══ a silent loop: restarted once, then reported ═══

test('a loop silent for 5 times its interval is started once more, and only reported when it stays silent', async () => {
  const clock = { now: NOW }
  const beats = makeBeats({ now: () => clock.now })
  let restarts = 0
  beats.registerLoop('predict', { label: 'Predict and warn', everyMs: MIN, restart: () => restarts++ })
  beats.beat('predict')
  const h = runner({ loops: async () => ({ loops: beats.loopsView() }) }, { clock, actions: makeRepairs({ restartLoop: n => beats.restartLoop(n) }) })
  await h.r.runOnce()
  assert.equal(restarts, 0)
  clock.now += 6 * MIN
  await h.r.runOnce()
  assert.equal(restarts, 1)
  assert.equal(one(h.r.view(), 'loops').state, 'degraded')
  clock.now += 10 * MIN
  await h.r.runOnce()
  assert.equal(restarts, 1, 'never a second restart')
  assert.equal(one(h.r.view(), 'loops').state, 'failing')
  beats.beat('predict')
  clock.now += MIN
  await h.r.runOnce()
  assert.equal(one(h.r.view(), 'loops').state, 'ok')
})

// ═══ stray servers: listed, never stopped by the watchdog ═══

test('stray servers are listed with their port, age and folder, and the watchdog never stops one', async () => {
  const kills = []
  const procs = [{ pid: 4242, port: 4497, startedAt: iso(NOW - 9 * 3_600_000), folder: 'C:/d/.worktrees/x', canStop: true }]
  const h = runner({ strays: async () => ({ procs, selfPid: 1 }) }, { actions: { ...makeRepairs({}), kill: pid => kills.push(pid) } })
  await h.r.runOnce()
  const c = one(h.r.view(), 'strays')
  assert.equal(c.state, 'degraded')
  assert.deepEqual(c.extra.strays.map(s => [s.pid, s.port, s.folder, s.canStop]), [[4242, 4497, 'C:/d/.worktrees/x', true]])
  assert.deepEqual(kills, [])
  assert.deepEqual(h.log(), [], 'no repair, so nothing in the repair log')
})

// ═══ the inbox and the urgent path ═══

test('alerts and gate stops go in the inbox once each; the first pass on a machine only remembers them; a stop is urgent', async () => {
  const items = []
  const notes = []
  const seen = { alerts: new Set(), stops: new Set() }
  let ev = { alerts: [{ key: 'a1', text: 'Old alert.' }], stops: [{ id: 'f1', text: 'f1 was stopped by QA.' }] }
  const inbox = {
    append: i => items.push(i), notify: n => notes.push(n), events: async () => ev, firstTime: () => true,
    noteNew: (kind, keys) => keys.filter(key => !seen[kind].has(key) && seen[kind].add(key)),
  }
  const h = runner({}, { inbox })
  await h.r.runOnce()
  assert.deepEqual(items, [], 'the first pass only remembers')
  ev = { alerts: [{ key: 'a1', text: 'Old alert.' }, { key: 'a2', text: 'Agent 1 uses tokens fast.' }], stops: [{ id: 'f1', text: 'x' }, { id: 'f2', text: 'f2 was stopped by Security.' }] }
  h.t.now += MIN
  await h.r.runOnce()
  assert.deepEqual(items.map(i => [i.kind, i.text]), [['alert', 'Agent 1 uses tokens fast.'], ['gate', 'f2 was stopped by Security.']])
  assert.deepEqual(notes.map(n => n.urgent), [true])
})

test('a state change is one inbox item each way; ok to ok is nothing', async () => {
  let health = { waiting: [{ agent: 'QA', since: iso(NOW - MIN), items: 1 }], fails: [] }
  const h = runner({ deliveries: async () => health })
  await h.r.runOnce()
  health = { waiting: [], fails: [] }
  h.t.now += MIN
  await h.r.runOnce()
  h.t.now += MIN
  await h.r.runOnce()
  assert.deepEqual(h.items.map(i => i.text.replace(/:.*/, '')), ['Deliveries to agents is degraded', 'Deliveries to agents is ok again.'])
})

// ═══ facts from the disk ═══

test('disk and config facts: sizes with the biggest evidence folders; config warnings collected; a config that does not parse', async () => {
  const d = dir()
  fs.mkdirSync(path.join(d, 'evidence', 'big'), { recursive: true })
  fs.writeFileSync(path.join(d, 'evidence', 'big', 'a.png'), Buffer.alloc(3000))
  fs.writeFileSync(path.join(d, 'spend.jsonl'), 'x'.repeat(10))
  const disk = await diskFacts({ dataDir: d, logs: [path.join(d, 'nope.log')] })
  assert.deepEqual(disk.biggest, [{ name: 'evidence/big', bytes: 3000 }])
  assert.equal(disk.items.find(i => i.key === 'spend').bytes, 10)
  const cfg = path.join(d, 'config.json')
  fs.writeFileSync(cfg, JSON.stringify({ healing: { enabled: 'yes' } }))
  const facts = await configFacts({ file: cfg, readers: [(raw, warn) => healingSettings(raw.healing, warn), () => { throw new Error('Collection x: kind must be switchboard or agent') }] })
  assert.equal(facts.parses, true)
  assert.equal(facts.warnings.length, 2)
  fs.writeFileSync(cfg, '{ "port": 4317, }')
  assert.equal((await configFacts({ file: cfg })).parses, false)
})

test('every check runs in one pass with all its facts, and config.json is never written by the watchdog', async () => {
  const facts = {
    refresh: async () => ({ collections: [], spend: [] }), deliveries: async () => ({ waiting: [], fails: [] }), stores: async () => ({ files: [] }),
    loops: async () => ({ loops: [] }), strays: async () => ({ procs: [], selfPid: 1 }), disk: async () => ({ items: [] }),
    config: async () => ({ parses: true, warnings: [] }), agents: async () => ({ status: { agents: [{ label: 'Master', coordinator: true }] }, coordinator: 'Master' }),
  }
  const h = runner(facts)
  await h.r.runOnce()
  const v = h.r.view()
  assert.deepEqual(v.checks.map(c => c.id), CHECK_IDS)
  assert.ok(v.checks.every(c => c.state === 'ok'), JSON.stringify(v.checks.filter(c => c.state !== 'ok')))
  assert.equal(v.worst, 'ok')
  assert.equal(h.state().seen.checks.length, 9, 'the last look is saved for the digest')
  assert.equal(fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null, configBefore)
})

test('a steady check (the server) shows a new state only once it held for 3 looks in a row: one swing is no inbox item', async () => {
  const clock = { now: NOW }
  const p99 = [100, 900, 900, 900, 100, 900, 900, 900, 900, 900]
  let i = 0
  const items = []
  const r = makeHealRunner({
    settings: () => ({ enabled: true, repairs: true }), now: () => clock.now, delay: { sample: () => ({ p99Ms: p99[i], maxMs: p99[i++] }) },
    stateFile: path.join(dir(), 'heal-state.json'), logFile: path.join(dir(), 'heal-log.jsonl'), log: () => {}, inbox: { append: x => items.push(x) },
  })
  const states = []
  for (let k = 0; k < p99.length; k++) {
    await r.runOnce()
    states.push(r.view().checks.find(c => c.id === 'server').state)
    clock.now += MIN
  }
  // the meter needs 3 slow minutes to say degraded, then the runner 3 looks of it in a row to show it
  assert.deepEqual(states, ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'degraded'])
  assert.deepEqual(items.map(x => x.text.split(':')[0]), ['The dashboard server is degraded'])
})
