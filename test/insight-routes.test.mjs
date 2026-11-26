// Tests for the insight routes (insight-routes.mjs) on a real http server on port 0, every dependency a stub except
// the suggestions store and the rules path, which run on a temp folder: the digest as data; Origin present and own on
// every write; the user's Accept, Reject (reason kept), Done and Accept and add the rule (through the SAME rules path
// as the user's own edit, marked master); each decision in Master's inbox; the watchdog's switch, Resume, Release and
// Stop. No model runs; config.json is never written.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-routes-test-'))
process.env.FACTORY_DATA_DIR = TMP
const { makeInsightRoute } = await import('../insight-routes.mjs')
const { suggest, readSuggestions } = await import('../insight-suggestions.mjs')
const { readRules, readLog, changeSentence, RULES_FILE, RULES_LOG } = await import('../agent-rules.mjs')
const { rulesPut } = await import('../agent-rules-routes.mjs')
const { readHealState } = await import('../heal-store.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json')
const configBefore = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null
const NOW = Date.parse('2026-11-26T12:00:00.000Z')
const FILE = path.join(TMP, 'suggestions.json')
const STATE = path.join(TMP, 'heal-state.json')
const GRAPH_CONFIG = { coordinatorLabel: 'Master', codingAgents: { Master: 'Master', a1: 'Agent 1' }, pipeline: { qa: 'QA' }, factory: { chat: { name: '' } } }

const calls = { inbox: [], resume: [], release: [], stop: [], runs: 0, switches: [], records: [] }
const view = () => ({ enabled: true, repairs: true, worst: 'failing', checks: [{ id: 'refresh', name: 'Paid ticket refresh', state: 'failing', text: 'Paused.' }, { id: 'loops', name: 'Background loops', state: 'degraded', text: 'Silent.' }], repairs24h: [{}], log: [] })
const runner = { view, runOnce: async () => calls.runs++, setSwitch: (id, on) => (calls.switches.push([id, on]), id === 'refresh'), record: l => calls.records.push(l) }
let server
let base
let port
before(async () => {
  let route
  server = createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, 'http://localhost')))) res.writeHead(404).end('nope')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  port = server.address().port
  base = `http://127.0.0.1:${port}`
  route = makeInsightRoute({
    port, file: FILE, stateFile: STATE, now: () => NOW, runner, agents: () => ['Master', 'Agent 1', 'QA'], learnDays: 14,
    providers: { graph: () => ({ nodes: [{ id: 'm', kind: 'agent', label: 'Master', role: 'coordinator' }], edges: [] }), suggestions: () => readSuggestions(FILE), inbox: () => ({ items: [], readAt: null }) },
    relay: { release: async a => (calls.release.push(a), a === 'Agent 1' ? { released: true, items: 2 } : { released: false, items: 0 }) },
    sources: { resume: id => (calls.resume.push(id), true) },
    procs: { stop: async (pid, at) => (calls.stop.push([pid, at]), pid === 7 ? { ok: true, pid: 7, port: 4497, folder: 'C:/d/.worktrees/x' } : { ok: false, error: 'That copy is not running any more.' }) },
    // the real rules path, on the temp folder, with the test's own graph
    rulesPut: (label, b, headers, opts) => rulesPut(label, b, headers, { ...opts, config: GRAPH_CONFIG, file: RULES_FILE, logFile: RULES_LOG, onChange: () => {} }),
    inbox: item => calls.inbox.push(item),
  })
})
after(() => new Promise(r => server.close(r)))

const own = () => ({ origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' })
const post = (p, body, headers = own()) => fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) })
let n = 0
const IDEAS = ['runs the whole suite before QA', 'writes a test step for each screen', 'names the ticket in every commit', 'keeps one branch per ticket', 'reads the brief twice', 'asks before a schema change', 'records a before shot', 'pins the node version']
const newOne = (over = {}) => suggest({ text: `Agent 1 ${IDEAS[n++ % IDEAS.length]}.`, why: `QA failed ${n + 1} of 9 flows.`, kind: 'rule', target: 'Agent 1', ...over }, { by: 'Master', now: NOW, targets: ['Master', 'Agent 1', 'QA'], newId: () => `s${String(n).padStart(6, '0')}` }, FILE).suggestion

test('GET the digest as data, one part with ?section, a part that does not exist refused', async () => {
  const all = await (await fetch(`${base}/api/insight/digest`)).json()
  assert.deepEqual(Object.keys(all.sections), ['pipeline', 'work', 'numbers', 'signals', 'health', 'suggestions'])
  assert.equal(all.sections.pipeline.ok, true)
  assert.equal(all.sections.work.ok, false, 'no flows provider: left out, never invented')
  const one = await (await fetch(`${base}/api/insight/digest?section=pipeline`)).json()
  assert.deepEqual(Object.keys(one.sections), ['pipeline'])
  assert.equal((await fetch(`${base}/api/insight/digest?section=nope`)).status, 400)
})

test('every write needs the page own Origin, present: none, another site and a lookalike are refused', async () => {
  const s = newOne()
  for (const headers of [{ 'content-type': 'application/json' }, { origin: 'http://evil.example', 'content-type': 'application/json' }, { origin: `http://127.0.0.1:${port + 1}` }]) {
    for (const p of [`/api/insight/suggestions/${s.id}`, '/api/heal/switch', '/api/heal/resume', '/api/heal/release', '/api/heal/stop', '/api/heal/run']) {
      const r = await post(p, { do: 'accept', check: 'refresh', on: false, collection: 'prod', agent: 'Agent 1', pid: 7 }, headers)
      assert.equal(r.status, 403, `${p} ${JSON.stringify(headers)}`)
    }
  }
  assert.equal(readSuggestions(FILE).list.find(x => x.id === s.id).state, 'open')
  assert.deepEqual([calls.resume, calls.release, calls.stop, calls.switches], [[], [], [], []])
  assert.equal((await fetch(`${base}/api/heal/run`, { method: 'PUT', headers: own() })).status, 405)
})

test('Accept and Reject: kept with the reason, each told to Master in the inbox; a decided one is not decided again', async () => {
  const a = newOne({ kind: 'process', target: '' })
  const r = await post(`/api/insight/suggestions/${a.id}`, { do: 'accept' })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).suggestion.state, 'accepted')
  assert.match(calls.inbox.at(-1).text, new RegExp(`^The user accepted ${a.id} .* Act on it, or tell the user who should\\.$`))
  assert.equal(calls.inbox.at(-1).kind, 'suggestion')
  const b = newOne({ kind: 'setting', target: 'outputs.max' })
  const rej = await post(`/api/insight/suggestions/${b.id}`, { do: 'reject', reason: 'I sign off on Fridays.' })
  assert.equal(rej.status, 200)
  assert.equal(readSuggestions(FILE).list.find(x => x.id === b.id).reason, 'I sign off on Fridays.')
  assert.match(calls.inbox.at(-1).text, /rejected .*: I sign off on Fridays\. Do not propose it again\.$/)
  assert.equal((await post(`/api/insight/suggestions/${b.id}`, { do: 'accept' })).status, 409)
  const done = await post(`/api/insight/suggestions/${a.id}`, { do: 'done' })
  assert.equal(done.status, 200)
  assert.equal((await post(`/api/insight/suggestions/${a.id}`, { do: 'maybe' })).status, 400)
  assert.equal((await post('/api/insight/suggestions/s999999', { do: 'accept' })).status, 404)
  assert.equal((await post('/api/insight/suggestions/..%2Fx', { do: 'accept' })).status, 404)
})

test('Accept and add the rule: saved through the rules path marked master (the log says so), then accepted with its verdict day', async () => {
  const s = newOne()
  const r = await post(`/api/insight/suggestions/${s.id}`, { do: 'rule' })
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
  const body = await r.json()
  assert.equal(body.suggestion.state, 'accepted')
  assert.equal(body.suggestion.outcome, 'Added as a rule of Agent 1; its verdict is due on 10 Dec.')
  assert.deepEqual(readRules(RULES_FILE).agents['Agent 1'].rules.map(x => x.text), [s.text])
  const line = readLog(RULES_LOG).at(-1)
  assert.equal(line.by, 'master')
  assert.match(changeSentence(line), /Agent 1 got 1 new rule\. A suggestion of the coordinator, accepted by you\./)
  // a rule already there is accepted with no second copy
  const again = suggest({ text: s.text, why: 'Seen 3 times.', kind: 'rule', target: 'QA' }, { by: 'Master', now: NOW, targets: ['Master', 'Agent 1', 'QA'] }, FILE).suggestion
  fs.writeFileSync(RULES_FILE, JSON.stringify({ agents: { QA: { spec: '', rules: [{ id: 'r1', text: s.text, addedAt: null }], updatedAt: null } } }))
  const twice = await (await post(`/api/insight/suggestions/${again.id}`, { do: 'rule' })).json()
  assert.equal(twice.suggestion.outcome, 'QA already had this rule.')
  // only a rule for an agent can be added as a rule
  const note = newOne({ kind: 'fix', target: '' })
  const refused = await post(`/api/insight/suggestions/${note.id}`, { do: 'rule' })
  assert.equal(refused.status, 400)
  assert.match((await refused.json()).error, /Accept it as a note instead/)
  assert.equal(readSuggestions(FILE).list.find(x => x.id === note.id).state, 'open', 'a refused rule leaves it open')
})

test('the summary for the rail, Home and the Agents page: open suggestions and the checks that are not ok', async () => {
  const j = await (await fetch(`${base}/api/insight/summary`)).json()
  assert.ok(j.suggestions.open >= 1)
  assert.equal(j.health.worst, 'failing')
  assert.deepEqual(j.health.failing.map(c => c.id), ['refresh'])
  assert.deepEqual(j.health.degraded.map(c => c.id), ['loops'])
  const list = await (await fetch(`${base}/api/insight/suggestions`)).json()
  assert.equal(list.list[0].state, 'open', 'open ones first')
  assert.deepEqual(list.agents, ['Master', 'Agent 1', 'QA'])
})

test('the watchdog: switch, Resume (kept so old turns are not held against it), Release, Stop (refused in plain words), run', async () => {
  assert.equal((await post('/api/heal/switch', { check: 'refresh', on: false })).status, 200)
  assert.equal((await post('/api/heal/switch', { check: 'nope', on: false })).status, 400)
  assert.equal((await post('/api/heal/switch', { check: 'refresh' })).status, 400)
  assert.equal((await post('/api/heal/resume', { collection: 'prod' })).status, 200)
  assert.deepEqual(calls.resume, ['prod'])
  assert.equal(readHealState(STATE).resumed.prod, new Date(NOW).toISOString())
  assert.equal(calls.records.at(-1).result, 'by you')
  assert.equal((await post('/api/heal/resume', { collection: '../x' })).status, 400)
  assert.equal((await post('/api/heal/release', { agent: 'Agent 1' })).status, 200)
  assert.match(calls.records.at(-1).did, /Released 2 held deliveries to Agent 1\./)
  assert.equal((await post('/api/heal/release', { agent: 'QA' })).status, 404)
  const stopped = await post('/api/heal/stop', { pid: 7, startedAt: '2026-11-26T01:00:00Z' })
  assert.equal(stopped.status, 200)
  assert.deepEqual(calls.stop.at(-1), [7, '2026-11-26T01:00:00Z'])
  assert.match(calls.records.at(-1).did, /Stopped the copy on port 4497 in C:\/d\/\.worktrees\/x\./)
  const gone = await post('/api/heal/stop', { pid: 8 })
  assert.equal(gone.status, 409)
  assert.equal((await gone.json()).error, 'That copy is not running any more.')
  const before = calls.runs
  assert.equal((await post('/api/heal/run', {})).status, 200)
  assert.equal(calls.runs, before + 1)
  assert.equal((await fetch(`${base}/api/heal`)).status, 200)
  assert.equal(fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null, configBefore)
})
