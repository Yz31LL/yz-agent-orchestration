// Tests for the flow, commit and evidence routes in factory-routes.mjs. A real
// http server on port 0 calls factoryRoute with a fake git and a recording
// relay. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports, so
// no test ever touches the real data/ folder.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-test-'))
const F = await import('../flows.mjs')
const { factoryRoute } = await import('../factory-routes.mjs')
const { requestText } = await import('../relay.mjs')
const { CONFIG } = await import('../config.mjs')

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
/** The fixture as flow `dark`, its output refs moved to that evidence folder (validateFlow holds them there). */
function darkFixture() {
  const f = { ...structuredClone(FIXTURE), id: 'dark' }
  for (const r of f.output.result) r.ref = r.ref.replace('dark-mode/', 'dark/')
  for (const t of f.output.testing) t.shot = t.shot.replace('dark-mode/', 'dark/')
  return f
}
const node = (flow, id) => flow.nodes.find(n => n.id === id)
const LONG = 'x'.repeat(400_010)

/** Canned `git show` output for ab12cd3 (and a huge patch for fff0000); anything else fails. */
async function git(args) {
  const sha = args.at(-1)
  if (sha !== 'ab12cd3' && sha !== 'fff0000') return { ok: false, out: '', err: 'bad revision' }
  if (args.includes('-s')) return { ok: true, out: 'web: theme tokens\0Adds the colour tokens\0dev\x002026-11-12', err: '' }
  if (args.includes('--name-status')) return { ok: true, out: 'M\tweb/tokens.css\nA\tweb/theme.test.js', err: '' }
  return { ok: true, out: sha === 'fff0000' ? LONG : 'diff --git a/x b/x', err: '' }
}

const calls = []
const relay = {
  queue: (...a) => calls.push(['queue', ...a]),
  queueStatus: (...a) => calls.push(['queueStatus', ...a]),
  queueRequest: (...a) => calls.push(['queueRequest', ...a]),
  deliverNow: async (...a) => (calls.push(['deliverNow', ...a]), { ok: false, error: 'agent is gone' }),
}

/** The explain fallback, stubbed: records each text and answers at once (no Claude turn). */
const explained = []
const explain = async text => (explained.push(text), text === 'boom' ? { error: 'exited with code 1' } : { text: `About ${text}.`, cost: 0.003 })

let server
let base
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await factoryRoute(req, res, url, { git, relay, explain }))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  fs.mkdirSync(path.join(F.EVIDENCE_DIR, 'dark'), { recursive: true })
  fs.writeFileSync(path.join(F.EVIDENCE_DIR, 'dark', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(F.DATA_DIR, 'config.json'), '{"secret":1}')
})
after(() => {
  server.close()
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
})

/** A fresh `dark` flow (the spec 7.1 example) and a broken `bad` file before every test. */
beforeEach(() => {
  calls.length = 0
  explained.length = 0
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
  fs.writeFileSync(path.join(F.FLOWS_DIR, 'dark.json'), JSON.stringify(darkFixture()))
  fs.writeFileSync(path.join(F.FLOWS_DIR, 'bad.json'), JSON.stringify({ id: 'bad', title: '', nodes: [] }))
})

const get = (p) => fetch(base + p)
const post = (p, body, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('GET /api/flows lists the valid flow and reports the invalid file', async () => {
  const r = await get('/api/flows')
  assert.equal(r.status, 200)
  const { flows, invalid } = await r.json()
  assert.equal(flows.length, 1)
  assert.equal(flows[0].id, 'dark')
  assert.deepEqual(flows[0].derived.waiting, ['n3'])
  assert.equal(invalid[0].id, 'bad')
})

test('GET /api/flows filters by agent', async () => {
  const { flows } = await (await get('/api/flows?agent=Nobody')).json()
  assert.equal(flows.length, 0)
})

test('GET /api/flows/<id> returns the flow with derived, 404 when missing, 400 on a bad id', async () => {
  const r = await get('/api/flows/dark')
  assert.equal(r.status, 200)
  assert.deepEqual((await r.json()).derived.progress, { done: 2, total: 3 })
  const missing = await get('/api/flows/nope')
  assert.equal(missing.status, 404)
  assert.ok((await missing.json()).error)
  assert.equal((await get('/api/flows/DARK')).status, 400)
})

test('POST answer writes the answer and queues it for the agent', async () => {
  const r = await post('/api/flows/dark/answer', { node: 'n3', answer: 'yes' })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).answer, 'yes')
  assert.equal(node(F.readFlow('dark'), 'n3').answer, 'yes')
  assert.deepEqual(calls, [['queue', 'dark', 'n3']])
})

test('POST answer null reopens the ask and queues nothing', async () => {
  await post('/api/flows/dark/answer', { node: 'n3', answer: 'yes' })
  calls.length = 0
  const r = await post('/api/flows/dark/answer', { node: 'n3', answer: null })
  assert.equal(r.status, 200)
  assert.equal(node(F.readFlow('dark'), 'n3').answer, null)
  assert.deepEqual(calls, [])
})

test('POST an empty answer is refused with 400 and the file is unchanged', async () => {
  const r = await post('/api/flows/dark/answer', { node: 'n3', answer: ' ' })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /answer must be yes, no, your own words or null/)
  assert.equal(node(F.readFlow('dark'), 'n3').answer, null)
  assert.deepEqual(calls, [])
})

test('POST answer re-reads the file, so an edit made since is kept', async () => {
  const flow = F.readFlow('dark')
  node(flow, 'n4').title = 'Changed on disk'
  F.writeFlow(flow)
  await post('/api/flows/dark/answer', { node: 'n3', answer: 'no' })
  const now = F.readFlow('dark')
  assert.equal(node(now, 'n4').title, 'Changed on disk')
  assert.equal(node(now, 'n3').answer, 'no')
})

test('POST answer from another origin is refused with 403', async () => {
  const r = await post('/api/flows/dark/answer', { node: 'n3', answer: 'yes' }, { origin: 'http://evil.example' })
  assert.equal(r.status, 403)
  assert.equal(node(F.readFlow('dark'), 'n3').answer, null)
})

test('POST to a bad flow id is refused with 400, a missing flow with 404', async () => {
  assert.equal((await post('/api/flows/..%2fx/answer', { node: 'n3', answer: 'yes' })).status, 400)
  assert.equal((await post('/api/flows/nope/answer', { node: 'n3', answer: 'yes' })).status, 404)
})

test('POST verify ticks the node as the user, and false clears it', async () => {
  const r = await post('/api/flows/dark/verify', { node: 'n1', verified: true })
  assert.equal(r.status, 200)
  const v = node(F.readFlow('dark'), 'n1').verified
  assert.equal(v.by, 'you')
  assert.ok(v.at)
  await post('/api/flows/dark/verify', { node: 'n1', verified: false })
  assert.equal(node(F.readFlow('dark'), 'n1').verified, null)
})

test('POST verify on an ask is refused with 400', async () => {
  assert.equal((await post('/api/flows/dark/verify', { node: 'n3', verified: true })).status, 400)
})

test('POST status sets a node status, or the flow status without a node', async () => {
  assert.equal((await post('/api/flows/dark/status', { node: 'n4', status: 'doing' })).status, 200)
  assert.equal(node(F.readFlow('dark'), 'n4').status, 'doing')
  assert.equal((await post('/api/flows/dark/status', { status: 'blocked' })).status, 200)
  assert.equal(F.readFlow('dark').status, 'blocked')
  assert.equal((await post('/api/flows/dark/status', { status: 'finished' })).status, 400)
  assert.equal(F.readFlow('dark').status, 'blocked')
})

test('POST status on a node after an ask queues one relay line for the agent; a node with no ask upstream queues none', async () => {
  assert.equal((await post('/api/flows/dark/status', { node: 'n4', status: 'skipped' })).status, 200)
  assert.deepEqual(calls, [['queueStatus', 'dark', 'n4']])
  calls.length = 0
  assert.equal((await post('/api/flows/dark/status', { node: 'n1', status: 'doing' })).status, 200)
  assert.equal((await post('/api/flows/dark/status', { status: 'done' })).status, 200)
  assert.deepEqual(calls, [])
  assert.equal((await post('/api/flows/dark/status', { node: 'n9', status: 'done' })).status, 400)
  assert.deepEqual(calls, [], 'nothing queued for a change that was refused')
})

test('POST drop marks the flow dropped', async () => {
  const r = await post('/api/flows/dark/drop', {})
  assert.equal(r.status, 200)
  assert.equal(F.readFlow('dark').status, 'dropped')
})

test('POST deliver hands the node to the relay and returns its result', async () => {
  const r = await post('/api/flows/dark/deliver', { node: 'n3' })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: false, error: 'agent is gone' })
  assert.deepEqual(calls, [['deliverNow', 'dark', 'n3']])
})

test('the old decision routes are gone', async () => {
  assert.equal((await post('/api/factory/decision', {})).status, 404)
})

test('GET /api/commit refuses a sha that is not hex', async () => {
  assert.equal((await get('/api/commit?sha=zz')).status, 400)
  assert.equal((await get('/api/commit')).status, 400)
})

test('GET /api/commit returns the parsed commit', async () => {
  const r = await get('/api/commit?sha=ab12cd3')
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), {
    sha: 'ab12cd3',
    subject: 'web: theme tokens',
    body: 'Adds the colour tokens',
    author: 'dev',
    date: '2026-11-12',
    files: [{ status: 'M', path: 'web/tokens.css' }, { status: 'A', path: 'web/theme.test.js' }],
    patch: 'diff --git a/x b/x',
  })
})

test('GET /api/commit cuts a huge patch at 400 KB', async () => {
  const { patch } = await (await get('/api/commit?sha=fff0000')).json()
  assert.equal(patch, 'x'.repeat(400_000) + '\n… diff cut at 400 KB')
})

test('GET /api/commit is 404 when git show fails', async () => {
  assert.equal((await get('/api/commit?sha=0000000')).status, 404)
})

test('GET /evidence serves an allowed file with no-store', async () => {
  const r = await get('/evidence/dark/shot.png')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/png')
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff', 'an agent-written file is never sniffed into HTML')
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47])
})

test('GET /evidence refuses a path outside the evidence folder with 403', async () => {
  const r = await get('/evidence/..%2f..%2fconfig.json')
  assert.equal(r.status, 403)
  assert.doesNotMatch(await r.text(), /secret/)
})

test('GET /evidence is 404 for a file type that is not allowed, or a missing file', async () => {
  fs.writeFileSync(path.join(F.EVIDENCE_DIR, 'dark', 'x.exe'), 'MZ')
  assert.equal((await get('/evidence/dark/x.exe')).status, 404)
  assert.equal((await get('/evidence/dark/none.png')).status, 404)
})

// ═══ /api/chat/new ═══

test('POST /api/chat/new with fork true makes the next chat fork once; a plain one clears it', async () => {
  let r = await post('/api/chat/new', { fork: true })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).nextFork, true)
  r = await post('/api/chat/new', {})
  assert.equal((await r.json()).nextFork, false)
  // only a real true forks: a string is a plain new chat
  r = await post('/api/chat/new', { fork: 'yes' })
  assert.equal((await r.json()).nextFork, false)
  // a JSON null body is a plain new chat too, not a 500
  r = await post('/api/chat/new', null)
  assert.equal(r.status, 200)
  assert.equal((await r.json()).nextFork, false)
})

test('POST /api/chat/new from another origin is refused with 403', async () => {
  const r = await post('/api/chat/new', { fork: true }, { origin: 'http://evil.example' })
  assert.equal(r.status, 403)
})

// ═══ /api/explain ═══

test('POST /api/explain answers with the text and cost of the fallback turn', async () => {
  // A selection the glossary does not hold: a known word is answered from the glossary (glossary-routes.test.mjs).
  const r = await post('/api/explain', { text: 'rebase onto main' })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { text: 'About rebase onto main.', cost: 0.003, from: 'model', saved: true })
  assert.deepEqual(explained, ['rebase onto main'])
})

test('POST /api/explain from another origin is refused with 403 and runs nothing', async () => {
  const r = await post('/api/explain', { text: 'merge base' }, { origin: 'http://evil.example' })
  assert.equal(r.status, 403)
  assert.deepEqual(explained, [])
})

test('POST /api/explain with text that is not a non-empty string is refused with 400 and runs nothing', async () => {
  for (const b of [{}, { text: 42 }, { text: null }, { text: ['a'] }, { text: '  ' }]) {
    const r = await post('/api/explain', b)
    assert.equal(r.status, 400, JSON.stringify(b))
    assert.ok((await r.json()).error)
  }
  assert.deepEqual(explained, [])
})

test('POST /api/explain with more than 500 characters is refused with 400 before any run', async () => {
  const r = await post('/api/explain', { text: 'x'.repeat(501) })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /500/)
  assert.deepEqual(explained, [])
})

test('POST /api/explain passes a failed turn on as 502 { error }', async () => {
  const r = await post('/api/explain', { text: 'boom' })
  assert.equal(r.status, 502)
  assert.deepEqual(await r.json(), { error: 'exited with code 1' })
})

test('GET /api/explain is not a route', async () => {
  assert.equal((await get('/api/explain')).status, 404)
})

// ═══ GET /api/spend (spec F4) ═══

test('GET /api/spend answers today, byKind and recent from data/spend.jsonl, unrounded', async () => {
  const S = await import('../spend.mjs')
  fs.writeFileSync(S.SPEND_FILE, '')
  S.recordCost('explain', 0.0013)
  S.recordCost('chat', 0.4401)
  fs.appendFileSync(S.SPEND_FILE, '{ broken\n')
  const r = await get('/api/spend')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  const body = await r.json()
  assert.ok(Math.abs(body.today - 0.4414) < 1e-9)
  assert.equal(body.byKind.explain, 0.0013)
  assert.equal(body.byKind.chat, 0.4401)
  assert.equal(body.byKind.relay, 0)
  assert.deepEqual(body.recent.map(l => l.kind), ['chat', 'explain'])
})

test('GET /api/spend needs no same origin: it only reads', async () => {
  const r = await fetch(base + '/api/spend', { headers: { origin: 'http://evil.example' } })
  assert.equal(r.status, 200)
})

test('POST /api/spend is not a route', async () => {
  assert.equal((await post('/api/spend', {})).status, 404)
})

test('server.mjs sends every path factory-routes.mjs answers to it (a route missing from FACTORY_PREFIXES is a 404 in the real server)', () => {
  const server = fs.readFileSync(path.join(HERE, '..', 'server.mjs'), 'utf8')
  const routes = fs.readFileSync(path.join(HERE, '..', 'factory-routes.mjs'), 'utf8')
  const prefixes = JSON.parse(server.match(/const FACTORY_PREFIXES = (\[[^\]]*\])/)[1].replace(/'/g, '"'))
  const paths = [...routes.matchAll(/p === '([^']+)'/g)].map(m => m[1])
  assert.ok(paths.includes('/api/spend'), 'the spend route is among them')
  assert.deepEqual(paths.filter(p => !prefixes.some(x => p.startsWith(x))), [])
})

// ═══ POST /api/flows/<id>/request-tests (the Output view's Request test steps) ═══

test('GET /api/flows and /api/flows/<id> carry the output and derived.output', async () => {
  const { flows } = await (await get('/api/flows')).json()
  assert.equal(flows[0].output.testing.length, 2)
  assert.deepEqual(flows[0].derived.output, { hasResult: true, hasSummary: true, tests: 2, hasDiagram: true, visual: 'shots', complete: true, hasBefore: true, merge: { ready: false } })
  const one = await (await get('/api/flows/dark')).json()
  assert.equal(one.output.summary, FIXTURE.output.summary)
  assert.equal(one.derived.output.complete, true)
})

test('POST request-tests stamps requestedAt and queues exactly one request for the flow agent', async () => {
  const before = Date.now()
  const r = await post('/api/flows/dark/request-tests', { note: 'Use the guest account.' })
  assert.equal(r.status, 200)
  const body = await r.json()
  const flow = F.readFlow('dark')
  assert.deepEqual(body, { ok: true, via: 'relay', requestedAt: flow.output.requestedAt })
  assert.ok(Date.parse(flow.output.requestedAt) >= before - 1000)
  assert.deepEqual(calls, [['queueRequest', 'dark', 'Use the guest account.']])
  assert.equal(flow.output.summary, FIXTURE.output.summary, 'the rest of the output is untouched')
  assert.equal(flow.output.testing.length, 2)
})

test('POST request-tests with no note, on a flow with no output yet, makes the output with only the request fields', async () => {
  const flow = F.readFlow('dark')
  delete flow.output
  F.writeFlow(flow)
  const r = await post('/api/flows/dark/request-tests', {})
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(F.readFlow('dark').output), ['requestedAt', 'requestSentAt', 'requestError'])
  assert.deepEqual(calls, [['queueRequest', 'dark', '']])
})

test('POST request-tests on a flow of the chat agent hands the text back for the Ask drawer and queues nothing', async () => {
  const flow = F.readFlow('dark')
  flow.agent = CONFIG.factory.chat.name
  F.writeFlow(flow)
  const r = await post('/api/flows/dark/request-tests', { note: 'Check the "guest" view.' })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'text', 'via'])
  assert.equal(body.ok, true)
  assert.equal(body.via, 'chat')
  assert.equal(body.text, requestText(F.readFlow('dark'), 'Check the "guest" view.'))
  assert.deepEqual(calls, [])
  assert.equal(F.readFlow('dark').output.requestedAt, null, 'nothing is requested until the user sends it')
})

test('POST request-tests on a chat flow with no screenshot and no diagram asks for a visual: flow diagram is in the text', async () => {
  const flow = F.readFlow('dark')
  flow.agent = CONFIG.factory.chat.name
  delete flow.output
  for (const n of flow.nodes) if (n.evidence) n.evidence = n.evidence.filter(e => e.kind !== 'shot')
  F.writeFlow(flow)
  const body = await (await post('/api/flows/dark/request-tests', {})).json()
  assert.match(body.text, /flow diagram dark "A -> B: label; B -> C"/)
  assert.match(body.text, /flow result dark --shot <file>/)
  flow.output = { diagram: { nodes: [{ id: 'a', label: 'A' }], edges: [] } }
  F.writeFlow(flow)
  const drawn = await (await post('/api/flows/dark/request-tests', {})).json()
  assert.doesNotMatch(drawn.text, /flow diagram dark "A -> B: label; B -> C"/, 'a diagram is a visual: only the test steps are asked for')
  assert.match(drawn.text, /flow diagram dark "A -> B: label" --before/, 'and the before half of the before and after')
  assert.deepEqual(calls, [])
})

test('POST request-tests is refused: another origin 403, a note over 500 characters or not text 400, a missing flow 404', async () => {
  assert.equal((await post('/api/flows/dark/request-tests', {}, { origin: 'http://evil.example' })).status, 403)
  const long = await post('/api/flows/dark/request-tests', { note: 'x'.repeat(501) })
  assert.equal(long.status, 400)
  assert.match((await long.json()).error, /500/)
  assert.equal((await post('/api/flows/dark/request-tests', { note: 42 })).status, 400)
  assert.equal((await post('/api/flows/nope/request-tests', {})).status, 404)
  assert.deepEqual(calls, [])
  assert.equal(F.readFlow('dark').output.requestedAt, null)
})

test('POST request-tests asked again clears what the relay made of the last one, so the page shows requested, not the old failure', async () => {
  const flow = F.readFlow('dark')
  Object.assign(flow.output, { requestedAt: '2026-11-13T09:00:00Z', requestSentAt: null, requestError: 'FAILED: no session' })
  F.writeFlow(flow)
  assert.equal((await post('/api/flows/dark/request-tests', {})).status, 200)
  const out = F.readFlow('dark').output
  assert.notEqual(out.requestedAt, '2026-11-13T09:00:00Z')
  assert.equal(out.requestError, null)
  assert.equal(out.requestSentAt, null)
})
