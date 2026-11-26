// Tests for the loops' heartbeats (heal-beats.mjs): a loop registers when it starts and beats when each pass ENDS; the
// watchdog's restart runs one more pass; and the server's loops (quality watch, QA rework watch, the Pull requests
// list, Predict and warn, Routing) really register and beat. Stubs only: no git, no gh, no model.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-beats-test-'))
process.env.FACTORY_DATA_DIR = TMP
const B = await import('../heal-beats.mjs')
const { makeQualityWatch } = await import('../quality-watch.mjs')
const { startReworkWatch } = await import('../qa-rework.mjs')
const { makePrList } = await import('../prlist-store.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
const HERE = path.dirname(fileURLToPath(import.meta.url))

test('register, beat, restart once: the view says when each loop last beat and when it was restarted', async () => {
  let t = Date.parse('2026-11-26T12:00:00.000Z')
  const b = B.makeBeats({ now: () => t })
  const passes = []
  assert.equal(b.registerLoop('x', { label: 'X loop', everyMs: 60_000, restart: () => passes.push('again') }), true)
  assert.equal(b.registerLoop('', { everyMs: 1 }), false)
  assert.equal(b.registerLoop('y', { everyMs: 0 }), false)
  assert.deepEqual(b.loopsView(), [{ name: 'x', label: 'X loop', everyMs: 60_000, startedAt: '2026-11-26T12:00:00.000Z', lastAt: null, restartedAt: null, lastMs: null }])
  t += 1000
  b.beat('x', 42)
  b.beat('unknown')
  assert.equal(b.loopsView()[0].lastAt, '2026-11-26T12:00:01.000Z')
  assert.equal(b.loopsView()[0].lastMs, 42)
  t += 1000
  assert.equal(b.restartLoop('x'), true)
  assert.deepEqual(passes, ['again'])
  assert.equal(b.loopsView()[0].restartedAt, '2026-11-26T12:00:02.000Z')
  assert.equal(b.restartLoop('unknown'), false)
  // a restart that throws is swallowed: the check sees the loop stay silent and reports it
  b.registerLoop('z', { everyMs: 1000, restart: () => { throw new Error('boom') } })
  assert.equal(b.restartLoop('z'), true)
  // registering again (a second start) keeps what was known
  b.registerLoop('x', { label: 'X loop', everyMs: 60_000 })
  assert.equal(b.loopsView()[0].lastAt, '2026-11-26T12:00:01.000Z')
})

test('the quality watch and the QA rework watch register on start and beat after each pass; the restart clears a hung guard', async () => {
  const watch = makeQualityWatch({ extractor: { busy: () => true }, critic: { busy: () => true }, git: async () => ({ ok: false, out: '' }), config: () => ({ quality: { lessons: 'off', critic: 'off' }, pipeline: {} }), every: 3_600_000 })
  const timer = watch.start()
  clearInterval(timer)
  await new Promise(r => setTimeout(r, 50))
  const q = B.loopsView().find(l => l.name === 'quality')
  assert.ok(q, 'registered')
  assert.equal(q.everyMs, 3_600_000)
  assert.ok(q.lastAt, 'beat after its first pass')
  const rework = startReworkWatch({ queueRework: () => {} }, 3_600_000)
  clearInterval(rework)
  const r = B.loopsView().find(l => l.name === 'rework')
  assert.ok(r?.lastAt)
  assert.equal(B.restartLoop('rework'), true)
})

test('the Pull requests list beats when a read ENDS, so a read that never ends never beats; its restart reads again', async () => {
  let release
  const hang = new Promise(r => (release = r))
  let calls = 0
  const store = makePrList({ gh: async () => (calls++, await hang, { ok: true, out: '{}' }), flows: () => [{ id: 'f', output: { pr: { url: 'https://github.com/o/r/pull/1', state: 'open' } } }], repo: 'o/r', everyMs: 3_600_000 })
  store.start()
  await new Promise(r => setTimeout(r, 20))
  const l = B.loopsView().find(x => x.name === 'prlist')
  assert.ok(l, 'registered')
  assert.equal(l.lastAt, null, 'the first read hangs: no beat')
  release()
  await store.idle()
  assert.ok(B.loopsView().find(x => x.name === 'prlist').lastAt, 'it beat once the read ended')
  assert.equal(B.restartLoop('prlist'), true)
  await store.idle()
  assert.ok(calls >= 2)
})

test('Predict and warn and Routing register and beat in their own start (the source says so; their tests run the sweeps)', () => {
  const predict = fs.readFileSync(path.join(HERE, '..', 'predict-routes.mjs'), 'utf8')
  assert.match(predict, /registerLoop\('predict', \{ label: 'Predict and warn \(estimates and alerts\)', everyMs: SWEEP_MS, restart: route\.restart \}\)/)
  assert.match(predict, /\.finally\(\(\) => beat\('predict', Date\.now\(\) - t\)\)/)
  const routing = fs.readFileSync(path.join(HERE, '..', 'routing-routes.mjs'), 'utf8')
  assert.match(routing, /registerLoop\('routing', \{ label: 'Routing outcomes', everyMs: SWEEP_MS, restart: route\.restart \}\)/)
  assert.match(routing, /beat\('routing', Date\.now\(\) - t\)/)
})
