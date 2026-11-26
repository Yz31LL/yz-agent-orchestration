// Tests for Master's insight commands (tools/insight-cli.mjs, behind tools/factory.mjs): suggest, suggestions and
// suggest-drop are the coordinator's alone (--by checked like the other role commands); orchestration asks the
// running dashboard first and otherwise builds the digest from the files, and the coordinator's whole read marks the
// inbox read. FACTORY_DATA_DIR is a temp folder; the spawned CLI is pointed at a port where nothing listens, so it
// never reaches a live dashboard.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-cli-test-'))
process.env.FACTORY_DATA_DIR = TMP
const C = await import('../tools/insight-cli.mjs')
const { readSuggestions } = await import('../insight-suggestions.mjs')
const { pipelineGraph } = await import('../pipeline.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'tools', 'factory.mjs')
const CONFIG = { coordinatorLabel: 'Master', codingAgents: { Master: 'Master', a1: 'Agent 1' }, pipeline: { qa: 'QA' }, factory: { chat: { name: 'Independent' } }, port: 1 }
let k = 0
const file = () => path.join(TMP, `c${k++}`, 'suggestions.json')
const f = (over = {}) => ({ _: [], ...over })
const SUGGEST = f({ _: ['Agent 1 runs the whole suite before QA.'], why: 'QA failed 4 of 9 flows from Agent 1.', kind: 'rule', target: 'Agent 1' })

test('suggest, suggestions, suggest-drop: the coordinator only, with the label it must be', () => {
  const fl = file()
  const deps = { file: fl, config: CONFIG, flowIds: () => new Set() }
  for (const cmd of ['suggest', 'suggestions', 'suggest-drop']) {
    const r = C.runSuggestions(cmd, SUGGEST, { by: 'Agent 1' }, deps)
    assert.equal(r.code, 1)
    assert.match(r.out, /Only Master suggests: --by must be "Master"/)
    assert.match(C.runSuggestions(cmd, SUGGEST, { by: '' }, deps).out, /--by/)
  }
  assert.equal(fs.existsSync(fl), false, 'nothing written for a refused command')
  const made = C.runSuggestions('suggest', SUGGEST, { by: 'Master' }, deps)
  assert.equal(made.code, 0)
  const id = /Suggestion (s[0-9a-f]{6}) is saved/.exec(made.out)[1]
  assert.match(made.out, /next digest/)
  // a rule for an agent that is not on the graph is refused
  assert.match(C.runSuggestions('suggest', f({ ...SUGGEST, target: 'Nobody' }), { by: 'Master' }, deps).out, /no agent called Nobody/)
  const list = C.runSuggestions('suggestions', f({ open: true }), { by: 'Master' }, deps)
  assert.equal(list.code, 0)
  assert.match(list.out, new RegExp(`1 open of 1, newest first:\\n${id}  open     rule    Agent 1 · `))
  assert.match(list.out, /Evidence: QA failed 4 of 9 flows from Agent 1\./)
  assert.equal(C.runSuggestions('suggest-drop', f({ _: [id] }), { by: 'Master' }, deps).code, 0)
  assert.equal(readSuggestions(fl).list.length, 0)
  assert.equal(C.runSuggestions('suggestions', f({ open: true }), { by: 'Master' }, deps).out, 'No open suggestions.')
})

test('the list says what the user did: a rejected one with its reason and "do not propose it again"', () => {
  const fl = file()
  fs.mkdirSync(path.dirname(fl), { recursive: true })
  fs.writeFileSync(fl, JSON.stringify({ suggestions: [{ id: 's0000aa', at: '2026-11-25T10:00:00.000Z', by: 'Master', kind: 'setting', target: 'outputs.max', text: 'Lower it.', why: '7 waited.', effort: '', state: 'rejected', decidedAt: '2026-11-26T09:00:00.000Z', reason: 'I sign off on Fridays.', outcome: '' }] }))
  const r = C.runSuggestions('suggestions', f(), { by: 'Master' }, { file: fl, config: CONFIG })
  assert.match(r.out, /Rejected 26 Nov: I sign off on Fridays\. Do not propose it again\./)
})

const DIGEST = { at: '2026-11-26T12:00:00.000Z', inbox: { items: [], readAt: null }, sections: { pipeline: { ok: true, data: { boxes: [{ label: 'Master', role: 'coordinator', kind: 'agent', state: 'busy' }], left: [] } } } }

test('orchestration: the running dashboard answers first; the coordinator\'s whole read marks the inbox read', async () => {
  const marks = []
  const deps = { config: CONFIG, ask: async ({ section }) => ({ ...DIGEST, asked: section }), files: () => assert.fail('the files are not read when the dashboard answers'), mark: at => marks.push(at) }
  const r = await C.runOrchestration(f(), { by: 'Master' }, deps)
  assert.equal(r.code, 0)
  assert.match(r.out, /^ORCHESTRATION DIGEST · 26 Nov/)
  assert.match(r.out, /== PIPELINE ==\nRoute: Master\n/)
  assert.deepEqual(marks, ['2026-11-26T12:00:00.000Z'])
  // another agent may read it; only the coordinator's read moves the marker
  await C.runOrchestration(f(), { by: 'Agent 1' }, deps)
  assert.equal(marks.length, 1)
  // one part only: the inbox lines are not shown, so nothing is marked
  const one = await C.runOrchestration(f({ section: 'Pipeline' }), { by: 'Master' }, deps)
  assert.match(one.out, /^== PIPELINE ==/)
  assert.equal(marks.length, 1)
  // --json gives the data, with where it came from
  const j = JSON.parse((await C.runOrchestration(f({ json: true }), { by: 'Agent 1' }, deps)).out)
  assert.equal(j.source, 'dashboard')
  assert.equal(j.sections.pipeline.data.boxes[0].label, 'Master')
  assert.match((await C.runOrchestration(f({ section: 'nope' }), { by: 'Master' }, deps)).out, /There is no part called nope\. The parts: pipeline, work, numbers, signals, health, suggestions\./)
})

test('orchestration with no dashboard running: built from the files, the head says so, and the missing parts are left out', async () => {
  const marks = []
  const graph = pipelineGraph(CONFIG)
  const r = await C.runOrchestration(f(), { by: 'Master' }, {
    config: CONFIG, ask: async () => null, mark: at => marks.push(at), now: () => Date.parse('2026-11-26T12:00:00.000Z'),
    files: () => ({ graph: () => graph, status: () => null, flows: () => [], prs: () => null, tokens: () => null, alerts: () => null, health: () => null, suggestions: () => ({ list: [], broken: false }), inbox: () => ({ items: [], readAt: null }) }),
  })
  assert.match(r.out, /built from the files: the dashboard is not running/)
  assert.match(r.out, /Left out: who is busy, idle or has no session/)
  assert.match(r.out, /== HEALTH ==\nLeft out:/)
  assert.equal(marks.length, 1)
})

test('askDashboard: a refused connection, a 404 (an older dashboard) or a wrong body is null, never a throw', async () => {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/insight/digest?section=pipeline')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(DIGEST))
    if (req.url === '/api/insight/digest') return res.writeHead(200).end('{"nope":1}')
    res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    assert.equal((await C.askDashboard({ port, section: 'pipeline' })).at, DIGEST.at)
    assert.equal(await C.askDashboard({ port }), null)
  } finally {
    await new Promise(r => server.close(r))
  }
  assert.equal(await C.askDashboard({ port, timeoutMs: 500 }), null)
})

test('the real CLI: --json before --by keeps the name, and the coordinator rule holds from a shell', async () => {
  // a port where nothing listens: the CLI must never reach a live dashboard from a test
  const s = createServer()
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const port = String(s.address().port)
  await new Promise(r => s.close(r))
  const env = { ...process.env, FACTORY_DATA_DIR: path.join(TMP, 'spawn'), PORT: port }
  const run = args => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env })
  const pipe = run(['orchestration', '--json', '--section', 'pipeline', '--by', 'Somebody'])
  assert.equal(pipe.status, 0, pipe.stderr)
  const j = JSON.parse(pipe.stdout)
  assert.equal(j.source, 'files')
  assert.deepEqual(Object.keys(j.sections), ['pipeline'])
  const refused = run(['suggest', 'Do a thing.', '--why', '3 of 4 failed.', '--kind', 'process', '--by', 'Somebody'])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /Only .* suggests: --by must be/)
  const usage = run([])
  assert.match(usage.stdout, /orchestration \[--json\] \[--section/)
  assert.match(usage.stdout, /suggest "<what to change>" --why/)
})
