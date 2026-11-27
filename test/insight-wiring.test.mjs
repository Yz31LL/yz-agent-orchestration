// Tests for insight-wiring.mjs and its place in server.mjs: the server makes it with one call, mounts its route with
// one line, tells the watchdog what each request took, and starts the watchdog once it listens. Built here with stubs
// (no session, no relay turn, no process list is read: the watchdog is never started) on a temp data folder.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-wiring-test-'))
process.env.FACTORY_DATA_DIR = TMP
const { makeInsightServer, STORES } = await import('../insight-wiring.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
const HERE = path.dirname(fileURLToPath(import.meta.url))

let server
let base
let kicked = 0
before(async () => {
  const insight = makeInsightServer({
    port: 0, cachedStatus: () => null, getStatus: async () => (kicked++, {}), relay: { health: () => ({ waiting: [], fails: [] }), hold: () => false, release: async () => ({ released: false }) },
    tokenRoute: { snapshot: () => ({ files: [], building: true }), index: { refresh: async () => {} } }, predictRoute: { alerts: async () => ({ body: { alerts: [] } }) },
    prListRoute: { list: { snapshot: () => ({ items: [] }) } }, present: async () => false,
  })
  server = createServer(async (req, res) => {
    if (!(await insight.route(req, res, new URL(req.url, 'http://localhost')))) res.writeHead(404).end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => new Promise(r => server.close(r)))

test('the digest from the server: no status yet kicks one read in the background and leaves the states out; the token index still building is said', async () => {
  const d = await (await fetch(`${base}/api/insight/digest`)).json()
  assert.equal(kicked, 1)
  assert.match(d.sections.pipeline.data.left[0], /who is busy, idle or has no session/)
  assert.deepEqual(d.sections.work.data.prs, [], 'the Pull requests list, as last read: none')
  assert.match(d.sections.numbers.data.left[0], /still being built/)
  assert.equal(d.sections.health.ok, true)
})

test('the watchdog view before its first pass: every check, not looked at yet', async () => {
  const v = await (await fetch(`${base}/api/heal`)).json()
  assert.equal(v.checks.length, 9)
  assert.ok(v.checks.every(c => c.state === 'ok' && c.text === 'Not looked at yet.'))
  assert.deepEqual(STORES.map(s => s.name), ['token-index.json', 'standup/index.json', 'lessons.json', 'suggestions.json', 'alerts-state.json'])
})

test('server.mjs: one call to make it, one line to mount it, one to time each request, one to start the watchdog', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server.mjs'), 'utf8')
  assert.match(src, /import \{ makeInsightServer \} from '\.\/insight-wiring\.mjs'/)
  assert.match(src, /const insightServer = makeInsightServer\(\{ port: PORT, cachedStatus: \(\) => cache\?\.data \?\? null, getStatus, relay,/)
  assert.match(src, /if \(await insightServer\.route\(req, res, url\)\) return/)
  assert.match(src, /res\.on\('finish', \(\) => insightServer\.noteWork\(/)
  assert.match(src, /insightServer\.start\(\) \/\/ the watchdog/)
})
